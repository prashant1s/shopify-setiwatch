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
 *   4. When Shopify marks that resulting order as paid, Shopify calls
 *      this worker's /webhook with the order — which is how we find
 *      out, reliably, that payment succeeded (never trust a client-side
 *      "success" callback for money).
 *   5. The worker looks up which repair job the order belongs to (via
 *      a note left on the draft order) and marks it paid.
 *
 * No Razorpay credentials are needed anywhere in this project — Shopify
 * owns that relationship already, through whatever app/gateway set up
 * "Razorpay Secure" as a checkout payment method.
 *
 * Required secrets (set with `wrangler secret put <NAME>`):
 *   SHOPIFY_STORE_DOMAIN   - e.g. f7b00a-eb.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN    - custom app Admin API token with scopes:
 *                            read_metaobjects, write_metaobjects,
 *                            read_draft_orders, write_draft_orders
 *   SHOPIFY_WEBHOOK_SECRET - the custom app's Client Secret (this is
 *                            what Shopify signs webhooks with — find it
 *                            on the app's "API credentials" page)
 *   ALLOWED_ORIGIN         - the storefront origin allowed to call this,
 *                            e.g. https://sethiwatch.com (comma-separate
 *                            more than one while testing)
 *
 * See README.md in this folder for step-by-step deploy instructions,
 * including registering the orders/paid webhook.
 */

const SHOPIFY_API_VERSION = '2026-07';
const METAOBJECT_TYPE = 'sethi_repair_job';
const NOTE_PREFIX = 'repair_job_handle:';

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
  const response = await fetch(
    `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN
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
 * Shopify webhook — topic ORDERS_PAID. This is the only reliable way to
 * know a payment actually succeeded; nothing about payment status is
 * ever trusted from the browser. Register this once with:
 *   webhookSubscriptionCreate(topic: ORDERS_PAID, webhookSubscription: { uri: "{this worker's URL}/webhook" })
 * See README.md.
 */
async function handleWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('X-Shopify-Hmac-Sha256') || '';

  const isValid = await verifyShopifyWebhookSignature(env, rawBody, signature);
  if (!isValid) return json({ ok: false, error: 'Invalid webhook signature' }, 401);

  const order = JSON.parse(rawBody);
  const note = order.note || '';
  if (!note.startsWith(NOTE_PREFIX)) {
    // Not a repair payment order — some other order paid normally. Ignore.
    return json({ ok: true, skipped: true }, 200);
  }

  const handle = note.slice(NOTE_PREFIX.length).toLowerCase();
  if (!isValidHandle(handle)) return json({ ok: true, skipped: true }, 200);

  const job = await getRepairJob(env, handle);
  if (job && job.fields.payment_status !== 'Paid') {
    await upsertRepairJob(env, handle, {
      customer_decision: 'Approved',
      payment_status: 'Paid',
      linked_order: `gid://shopify/Order/${order.id}`,
      customer_decision_at: new Date().toISOString()
    });
  }

  return json({ ok: true }, 200);
}

async function verifyShopifyWebhookSignature(env, rawBody, signatureBase64) {
  if (!env.SHOPIFY_WEBHOOK_SECRET || !signatureBase64) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SHOPIFY_WEBHOOK_SECRET),
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
