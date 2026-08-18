/*
 * Sethi Watch — repair approval & payment backend
 *
 * Implements the contract documented in sections/repair-tracker.liquid
 * (search that file for "BACKEND CONTRACT"). This uses Shopify's OWN
 * checkout — which already has Razorpay (plus Snapmint, cards, etc.)
 * configured as payment methods — instead of talking to Razorpay
 * directly. The flow is:
 *
 *   1. Customer clicks "Approve & pay" on the tracker page.
 *   2. This worker creates a Shopify Draft Order for the repair job's
 *      own estimated_cost (never trusting an amount from the browser)
 *      and returns its checkout URL.
 *   3. The browser redirects to that URL — a real Shopify checkout,
 *      with every payment method the store already has configured.
 *   4. When that draft order's checkout is paid, its own status flips to
 *      "completed" and Shopify calls this worker's /webhook — which is
 *      how we find out, reliably, that payment succeeded (never trust a
 *      client-side "success" callback for money).
 *   5. The worker looks up which repair job the draft order belongs to
 *      (via a note left on it) and marks it paid.
 *
 * No Razorpay credentials are needed anywhere in this project — Shopify
 * owns that relationship already, through whatever app/gateway set up
 * "Razorpay Secure" as a checkout payment method.
 *
 * AUTH MODEL (Dev Dashboard apps, not the old "custom apps in Shopify
 * admin" flow, which no longer exists as of Jan 2026): there's no static
 * long-lived Admin API token to copy-paste. Instead this worker exchanges
 * its Client ID + Client Secret for a short-lived (~24h) access token on
 * every request, via Shopify's client_credentials grant. The same Client
 * Secret is also what Shopify signs webhooks with, so it does double
 * duty here.
 *
 * Required secrets (set with `wrangler secret put <NAME>`):
 *   SHOPIFY_STORE_DOMAIN     - e.g. f7b00a-eb.myshopify.com
 *   SHOPIFY_CLIENT_ID        - from the app's Settings page in Dev
 *                              Dashboard, after it's installed on the
 *                              store, with scopes: read_metaobjects,
 *                              write_metaobjects, read_draft_orders,
 *                              write_draft_orders
 *   SHOPIFY_CLIENT_SECRET    - from the same Settings page
 *   ALLOWED_ORIGIN           - the storefront origin allowed to call
 *                              this, e.g. https://sethiwatch.com
 *                              (comma-separate more than one while
 *                              testing)
 *
 * See README.md in this folder for step-by-step deploy instructions,
 * including installing the app and registering the draft_orders/update
 * webhook.
 */

const SHOPIFY_API_VERSION = '2026-07';
const METAOBJECT_TYPE = 'sethi_repair_job';
const NOTE_PREFIX = 'repair_job_handle:';

/*
  Client credentials grant — exchanges Client ID + Client Secret for a
  fresh Admin API access token. Fetched once per request rather than
  cached: Workers don't guarantee memory persists between invocations,
  and this endpoint isn't high-traffic enough for the extra round trip
  to matter. Token is valid ~24h; we just don't rely on that window.
*/
async function getAccessToken(env) {
  const response = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET
    })
  });

  if (!response.ok) {
    throw new Error('Could not obtain a Shopify access token — check SHOPIFY_CLIENT_ID/SECRET and that the app is installed');
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Shopify token response had no access_token');
  }
  return data.access_token;
}

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const requestOrigin = request.headers.get('Origin') || '';
  const origin = allowed.includes(requestOrigin) ? requestOrigin : allowed[0] || '';

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin'
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function isValidHandle(handle) {
  return typeof handle === 'string' && /^[a-z0-9-]{1,100}$/.test(handle);
}

async function shopifyAdminGraphQL(env, query, variables) {
  const accessToken = await getAccessToken(env);

  const response = await fetch(
    `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors[0].message || 'Shopify Admin API returned an error');
  }
  return payload.data;
}

async function getRepairJob(env, handle) {
  const data = await shopifyAdminGraphQL(
    env,
    `query RepairJobLookup($handle: MetaobjectHandleInput!) {
      metaobjectByHandle(handle: $handle) {
        id
        handle
        fields { key value }
      }
    }`,
    { handle: { type: METAOBJECT_TYPE, handle } }
  );

  const metaobject = data.metaobjectByHandle;
  if (!metaobject) return null;

  const fields = {};
  metaobject.fields.forEach((field) => {
    fields[field.key] = field.value;
  });

  return { id: metaobject.id, handle: metaobject.handle, fields };
}

async function upsertRepairJob(env, handle, fields) {
  const data = await shopifyAdminGraphQL(
    env,
    `mutation RepairJobUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
        metaobject { id handle }
        userErrors { field message code }
      }
    }`,
    {
      handle: { type: METAOBJECT_TYPE, handle },
      metaobject: {
        fields: Object.entries(fields).map(([key, value]) => ({ key, value: String(value) }))
      }
    }
  );

  const userErrors = data.metaobjectUpsert.userErrors;
  if (userErrors?.length) {
    throw new Error(userErrors.map((e) => e.message).join('; '));
  }
}

/* ---------------------------------------------------------------------- */

async function handleDecision(request, env) {
  const body = await request.json();
  const handle = (body.handle || '').toLowerCase();
  const decision = body.decision;

  if (!isValidHandle(handle)) return json({ ok: false, error: 'Invalid handle' }, 400);
  if (decision !== 'declined') return json({ ok: false, error: 'Invalid decision' }, 400);

  const job = await getRepairJob(env, handle);
  if (!job) return json({ ok: false, error: 'Repair job not found' }, 404);

  if (job.fields.payment_status === 'Paid') {
    return json({ ok: false, error: 'This repair has already been paid for' }, 409);
  }

  await upsertRepairJob(env, handle, {
    customer_decision: 'Declined',
    customer_decision_at: new Date().toISOString()
  });

  return json({ ok: true }, 200);
}

async function handleCreateOrder(request, env) {
  const body = await request.json();
  const handle = (body.handle || '').toLowerCase();

  if (!isValidHandle(handle)) return json({ ok: false, error: 'Invalid handle' }, 400);

  const job = await getRepairJob(env, handle);
  if (!job) return json({ ok: false, error: 'Repair job not found' }, 404);

  if (job.fields.payment_status === 'Paid') {
    return json({ ok: false, error: 'This repair has already been paid for' }, 409);
  }
  if (job.fields.customer_decision === 'Declined') {
    return json({ ok: false, error: 'This repair was already declined' }, 409);
  }

  // Authoritative amount comes from the repair job itself, never the browser.
  const estimatedCost = parseFloat(job.fields.estimated_cost);
  if (!(estimatedCost > 0)) {
    return json({ ok: false, error: 'No estimated cost has been set for this repair yet' }, 400);
  }

  const watchLabel = [job.fields.brand, job.fields.model].filter(Boolean).join(' ') || 'watch';

  const data = await shopifyAdminGraphQL(
    env,
    `mutation CreateRepairDraftOrder($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id invoiceUrl }
        userErrors { field message }
      }
    }`,
    {
      input: {
        note: `${NOTE_PREFIX}${handle}`,
        tags: ['repair-payment'],
        useCustomerDefaultAddress: false,
        lineItems: [
          {
            title: `Watch repair — ${watchLabel} (${handle.toUpperCase()})`,
            quantity: 1,
            requiresShipping: false,
            originalUnitPriceWithCurrency: { amount: estimatedCost, currencyCode: 'INR' }
          }
        ]
      }
    }
  );

  const userErrors = data.draftOrderCreate.userErrors;
  if (userErrors?.length) {
    return json({ ok: false, error: userErrors.map((e) => e.message).join('; ') }, 502);
  }

  const invoiceUrl = data.draftOrderCreate.draftOrder.invoiceUrl;
  if (!invoiceUrl) {
    return json({ ok: false, error: 'Could not generate a checkout link' }, 502);
  }

  return json({ ok: true, checkout_url: invoiceUrl }, 200);
}

/*
 * Shopify webhook — topic DRAFT_ORDERS_UPDATE. This is the only reliable
 * way to know a payment actually succeeded; nothing about payment status
 * is ever trusted from the browser.
 *
 * Originally this used ORDERS_PAID, but that topic requires the
 * read_orders scope (and likely Shopify's "protected customer data"
 * approval, since orders carry customer PII) — access this app doesn't
 * have and doesn't need. DRAFT_ORDERS_UPDATE needs only
 * read_draft_orders, which the app already has: a draft order's own
 * `status` field flips to "completed" when its checkout is paid, which
 * is exactly the signal this needs, without ever touching order/customer
 * data. Register this once with:
 *   webhookSubscriptionCreate(topic: DRAFT_ORDERS_UPDATE, webhookSubscription: { uri: "{this worker's URL}/webhook" })
 * See README.md.
 *
 * Note this fires on EVERY update to ANY draft order in the store, not
 * just repair ones and not just completions — hence the status and note
 * checks below before doing anything.
 */
async function handleWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('X-Shopify-Hmac-Sha256') || '';

  const isValid = await verifyShopifyWebhookSignature(env, rawBody, signature);
  if (!isValid) return json({ ok: false, error: 'Invalid webhook signature' }, 401);

  const draftOrder = JSON.parse(rawBody);

  if (draftOrder.status !== 'completed') {
    // Some other edit to a draft order, or not paid yet. Ignore.
    return json({ ok: true, skipped: true }, 200);
  }

  const note = draftOrder.note || '';
  if (!note.startsWith(NOTE_PREFIX)) {
    // A draft order that completed, but not one of ours (e.g. a normal
    // staff-created invoice). Ignore.
    return json({ ok: true, skipped: true }, 200);
  }

  const handle = note.slice(NOTE_PREFIX.length).toLowerCase();
  if (!isValidHandle(handle)) return json({ ok: true, skipped: true }, 200);

  const job = await getRepairJob(env, handle);
  if (job && job.fields.payment_status !== 'Paid') {
    const fields = {
      customer_decision: 'Approved',
      payment_status: 'Paid',
      customer_decision_at: new Date().toISOString()
    };
    if (draftOrder.order_id) {
      fields.linked_order = `gid://shopify/Order/${draftOrder.order_id}`;
    }
    await upsertRepairJob(env, handle, fields);
  }

  return json({ ok: true }, 200);
}

async function verifyShopifyWebhookSignature(env, rawBody, signatureBase64) {
  // Shopify signs webhooks with the app's Client Secret — the same
  // credential used for the client_credentials token exchange above,
  // not a separately configured "webhook secret".
  if (!env.SHOPIFY_CLIENT_SECRET || !signatureBase64) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SHOPIFY_CLIENT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expectedBase64 = btoa(String.fromCharCode(...new Uint8Array(signed)));

  return timingSafeEqual(expectedBase64, signatureBase64);
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/* ---------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);

    // Shopify webhooks are server-to-server — no browser CORS involved,
    // and no Origin check needed (the signature check is what matters).
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        const result = await handleWebhook(request, env);
        return result;
      } catch (err) {
        console.error('[repair-payments-worker] webhook error', err);
        return json({ ok: false, error: 'Internal error' }, 500);
      }
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405, headers);
    }

    try {
      let result;
      if (url.pathname === '/decision') {
        result = await handleDecision(request, env);
      } else if (url.pathname === '/create-order') {
        result = await handleCreateOrder(request, env);
      } else {
        return json({ ok: false, error: 'Not found' }, 404, headers);
      }

      const body = await result.json();
      return json(body, result.status, headers);
    } catch (err) {
      console.error('[repair-payments-worker]', err);
      return json({ ok: false, error: 'Internal error' }, 500, headers);
    }
  }
};
