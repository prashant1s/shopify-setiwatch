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
const SERVICE_REQUEST_METAOBJECT_TYPE = 'sethi_service_request';

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

/*
 * Online booking intake — implements the contract used by
 * sections/book-watch-service.liquid ("Book online" panel). That panel
 * used to be a Shopify `{% form 'contact' %}`, which only fires an email
 * notification and keeps no retrievable record. This stores each
 * submission as its own `sethi_service_request` metaobject so staff can
 * review it in Shopify Admin and, once verified, hand-create the matching
 * `sethi_repair_job` (same as the retail-counter flow already does) —
 * that's also why this only ever creates "New" requests and never a
 * Repair ID directly: the copy on that page is explicit that a Repair ID
 * is issued only after staff verification.
 *
 * One-time setup needed in Shopify Admin (Content -> Metaobjects ->
 * Add definition) before this endpoint will work — type
 * `sethi_service_request` with single-line-text fields: request_id,
 * status, submitted_at, booking_source, full_name, phone,
 * contact_phone_last4, email, preferred_store, watch_brand, watch_model,
 * serial_number, service_type, purchase_source, invoice_available,
 * warranty_status, preferred_service_mode, and multi-line-text fields:
 * issue_description, condition_notes. No Storefront access needed — this
 * is staff-only data, read only through the Admin API this worker
 * already authenticates with (write_metaobjects, already granted).
 */

const SERVICE_REQUEST_ENUMS = {
  preferred_store: ['Krishna Nagar', 'Noida Sector 18', 'Noida Sector 120', 'Pickup request'],
  service_type: [
    'Complete servicing',
    'Battery replacement',
    'Strap or bracelet service',
    'Glass or crystal replacement',
    'Water resistance check',
    'Polishing and restoration',
    'Other'
  ],
  purchase_source: [
    'Sethi Watches',
    'Another authorised retailer',
    'Online marketplace',
    'Gift',
    'Other / unknown'
  ],
  invoice_available: ['Yes', 'No'],
  warranty_status: ['Under manufacturer warranty', 'Out of warranty', 'Not sure'],
  preferred_service_mode: ['Visit service centre', 'Pickup request', 'Call me first']
};

function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(value) {
  return /^[0-9+\-\s()]{10,16}$/.test(value);
}

function generateServiceRequestId() {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `SWR-REQ-${yy}${mm}${dd}-${suffix}`;
}

async function handleIntake(request, env) {
  const body = await request.json();

  // Honeypot: real visitors never fill this hidden field. Pretend success
  // without writing anything, so bots don't learn their submission failed.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return json({ ok: true, request_id: generateServiceRequestId() }, 200);
  }

  const fullName = cleanString(body.name, 80);
  const phone = cleanString(body.phone, 16);
  const email = cleanString(body.email, 120);
  const preferredStore = cleanString(body.preferred_store, 60);
  const watchBrand = cleanString(body.watch_brand, 60);
  const watchModel = cleanString(body.watch_model, 100);
  const serialNumber = cleanString(body.serial_number, 100);
  const serviceType = cleanString(body.service_type, 60);
  const purchaseSource = cleanString(body.purchase_source, 60);
  const invoiceAvailable = cleanString(body.invoice_available, 10);
  const warrantyStatus = cleanString(body.warranty_status, 60);
  const preferredServiceMode = cleanString(body.preferred_service_mode, 60);
  const issueDescription = cleanString(body.issue_description, 1500);
  const conditionNotes = cleanString(body.condition_notes, 800);
  const confirmed = body.confirmed === true;

  if (fullName.length < 3) return json({ ok: false, error: 'Please enter your full name.' }, 400);
  if (!isValidPhone(phone)) return json({ ok: false, error: 'Please enter a valid phone number.' }, 400);
  if (!isValidEmail(email)) return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
  if (!SERVICE_REQUEST_ENUMS.preferred_store.includes(preferredStore)) {
    return json({ ok: false, error: 'Please select a valid preferred store.' }, 400);
  }
  if (watchBrand.length < 2) return json({ ok: false, error: 'Please enter the watch brand.' }, 400);
  if (watchModel.length < 2) return json({ ok: false, error: 'Please enter the watch model / reference.' }, 400);
  if (!SERVICE_REQUEST_ENUMS.service_type.includes(serviceType)) {
    return json({ ok: false, error: 'Please select a valid service type.' }, 400);
  }
  if (!SERVICE_REQUEST_ENUMS.purchase_source.includes(purchaseSource)) {
    return json({ ok: false, error: 'Please select a valid purchase source.' }, 400);
  }
  if (!SERVICE_REQUEST_ENUMS.invoice_available.includes(invoiceAvailable)) {
    return json({ ok: false, error: 'Please select whether an invoice is available.' }, 400);
  }
  if (!SERVICE_REQUEST_ENUMS.warranty_status.includes(warrantyStatus)) {
    return json({ ok: false, error: 'Please select a valid warranty status.' }, 400);
  }
  if (!SERVICE_REQUEST_ENUMS.preferred_service_mode.includes(preferredServiceMode)) {
    return json({ ok: false, error: 'Please select a valid preferred service mode.' }, 400);
  }
  if (issueDescription.length < 20) {
    return json({ ok: false, error: 'Please describe the issue in at least 20 characters.' }, 400);
  }
  if (!confirmed) {
    return json({ ok: false, error: 'Please confirm the information provided is correct.' }, 400);
  }

  const contactPhoneLast4 = phone.replace(/\D/g, '').slice(-4);

  const fields = {
    status: 'New',
    submitted_at: new Date().toISOString(),
    booking_source: 'Website',
    full_name: fullName,
    phone,
    contact_phone_last4: contactPhoneLast4,
    email,
    preferred_store: preferredStore,
    watch_brand: watchBrand,
    watch_model: watchModel,
    serial_number: serialNumber,
    service_type: serviceType,
    purchase_source: purchaseSource,
    invoice_available: invoiceAvailable,
    warranty_status: warrantyStatus,
    preferred_service_mode: preferredServiceMode,
    issue_description: issueDescription,
    condition_notes: conditionNotes
  };

  // Retry with a fresh id on the (rare) chance of a handle collision —
  // request IDs are date-based with a random suffix, not sequential.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const requestId = generateServiceRequestId();

    const data = await shopifyAdminGraphQL(
      env,
      `mutation ServiceRequestCreate($metaobject: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject { id handle }
          userErrors { field message code }
        }
      }`,
      {
        metaobject: {
          type: SERVICE_REQUEST_METAOBJECT_TYPE,
          handle: requestId.toLowerCase(),
          fields: Object.entries({ ...fields, request_id: requestId }).map(([key, value]) => ({
            key,
            value: String(value)
          }))
        }
      }
    );

    const userErrors = data.metaobjectCreate.userErrors;
    if (!userErrors?.length) {
      return json({ ok: true, request_id: requestId }, 200);
    }

    const isHandleTaken = userErrors.some(
      (e) => e.code === 'TAKEN' || /already exists|has already been taken/i.test(e.message)
    );
    if (!isHandleTaken) {
      throw new Error(userErrors.map((e) => e.message).join('; '));
    }
    // else loop and try another generated id
  }

  throw new Error('Could not generate a unique request ID after several attempts');
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
      } else if (url.pathname === '/intake') {
        result = await handleIntake(request, env);
      } else {
        return json({ ok: false, error: 'Not found' }, 404, headers);
      }

      const body = await result.json();
      return json(body, result.status, headers);
    } catch (err) {
      console.error('[repair-payments-worker]', err);
      // These are thrown Shopify GraphQL userErrors or validation messages
      // (e.g. "serial_number can't be blank") — customer-safe text, not
      // secrets — so surface the real reason instead of a generic message
      // that requires tailing logs to diagnose.
      const message = err instanceof Error && err.message ? err.message : 'Internal error';
      return json({ ok: false, error: message }, 500, headers);
    }
  }
};
