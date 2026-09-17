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
 *   STAFF_API_KEY            - a long random string you make up yourself
 *                              (e.g. `openssl rand -hex 24`). Gates the
 *                              /staff/* endpoints and the /staff page —
 *                              this is store-staff tooling, not public.
 *
 * See README.md in this folder for step-by-step deploy instructions,
 * including installing the app and registering the draft_orders/update
 * webhook.
 *
 * STAFF WORKFLOW (service request -> repair job): the online booking
 * form only ever creates a `sethi_service_request` (see handleIntake
 * below) — it deliberately never creates a `sethi_repair_job` directly,
 * since nobody has verified the watch was actually received yet. Staff
 * turn a request into a trackable, payable repair job at
 * https://{this worker}/staff — that page lists open requests and, on
 * "Create repair job", calls /staff/promote, which creates the
 * `sethi_repair_job` metaobject using the SAME handle and phone-last-4
 * as the original request. That means the Repair ID the customer
 * already has from their booking confirmation just starts working on
 * the tracker — nobody has to generate or hand out a second ID. Further
 * status/estimate updates go through /staff/update-status, which the
 * same page's "Update repair job" form calls. Neither endpoint touches
 * the separate "Repair Job — Private" metaobject some stores may also
 * have set up by hand in Admin for internal-only notes — this flow is
 * self-contained and doesn't require that to exist.
 */

const SHOPIFY_API_VERSION = '2026-07';
const METAOBJECT_TYPE = 'sethi_repair_job';
const NOTE_PREFIX = 'repair_job_handle:';
const SERVICE_REQUEST_METAOBJECT_TYPE = 'sethi_service_request';

/*
  The 13 fixed status choices staff can pick in Shopify Admin on the
  `sethi_repair_job` status field — kept in sync with STATUS_STEP_MAP in
  sections/repair-tracker.liquid so the /staff page offers the same
  choices Admin does.
*/
const REPAIR_JOB_STATUS_OPTIONS = [
  'Received at counter',
  'Inspected & quoted',
  'Awaiting customer approval',
  'Awaiting parts',
  'In workshop',
  'Sent to brand service centre',
  'Returned from service centre',
  'Final quality check',
  'Ready for collection',
  'Collected in store',
  'Delivered by courier',
  'Cancelled',
  'Returned unrepaired'
];

/*
  NOT a hardcoded enum on purpose: the theme's only actual requirement
  is `fields.warranty_or_paid === 'Warranty'` (see repair-tracker.liquid)
  — everything else falls into the paid/estimate flow regardless of the
  exact wording. The live metaobject definition's non-warranty choice
  turned out to be "Chargeable", not "Paid" (learned from a real webhook
  payload) — rather than re-guess and risk being wrong again, this is
  just validated as "non-blank", trusting Shopify's own field validation
  (its userErrors already surface clearly through the normal error path)
  to be the actual source of truth for what values are allowed.
*/
function isNonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

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

/*
  Staff-only endpoints (/staff/*) are gated by a shared secret the store
  sets once (STAFF_API_KEY) and staff paste into the /staff page, which
  remembers it in that browser's localStorage. This is deliberately the
  same lightweight style as the rest of this worker (no per-staff login,
  no session) — good enough for a small internal tool a handful of
  counter staff use, not a replacement for real auth if this ever needs
  to scale beyond that.
*/
function isStaffAuthorized(request, env) {
  const provided = request.headers.get('X-Staff-Key') || '';
  const expected = env.STAFF_API_KEY || '';
  if (!expected) return false;
  return timingSafeEqual(provided, expected);
}

function formatLogDate() {
  return new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/*
 * Builds a `sethi_repair_job` fields object from a `sethi_service_request`
 * fields object, copying over the customer-safe details that never
 * change (brand, model, phone-last-4, etc.) and applying whatever
 * status/location/warranty/estimate the caller supplies — used both by
 * the automatic repair job created at intake time (handleIntake, with
 * inferred defaults) and by staff's manual /staff/promote (with values
 * staff typed in).
 */
function buildRepairJobFieldsFromServiceRequest(sr, opts) {
  const latestUpdateNote = opts.latestUpdateNote || 'Repair job created from your online service request.';

  const fields = {
    status: opts.status,
    current_location: opts.currentLocation || 'Our counter',
    intake_date: sr.submitted_at || new Date().toISOString(),
    brand: sr.watch_brand || '',
    model: sr.watch_model || '',
    reference_sku: sr.serial_number || '',
    contact_phone_last4: sr.contact_phone_last4 || '',
    condition_on_arrival: sr.issue_description || '',
    accessories_received: sr.condition_notes || '',
    warranty_or_paid: opts.warrantyOrPaid,
    latest_update_note: latestUpdateNote,
    customer_facing_summary: latestUpdateNote,
    status_history_log: `${formatLogDate()}: ${opts.status}${opts.logSuffix ? ` — ${opts.logSuffix}` : ''}`
  };

  if (opts.promisedByDate) fields.promised_by_date = opts.promisedByDate;

  if (opts.estimatedCost !== undefined && opts.estimatedCost !== '') {
    const estimatedCost = parseFloat(opts.estimatedCost);
    if (!Number.isNaN(estimatedCost) && estimatedCost > 0) fields.estimated_cost = String(estimatedCost);
  }

  return fields;
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
        updatedAt
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

  return { id: metaobject.id, handle: metaobject.handle, updatedAt: metaobject.updatedAt, fields };
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

async function getServiceRequest(env, handle) {
  const data = await shopifyAdminGraphQL(
    env,
    `query ServiceRequestLookup($handle: MetaobjectHandleInput!) {
      metaobjectByHandle(handle: $handle) {
        id
        handle
        updatedAt
        fields { key value }
      }
    }`,
    { handle: { type: SERVICE_REQUEST_METAOBJECT_TYPE, handle } }
  );

  const metaobject = data.metaobjectByHandle;
  if (!metaobject) return null;

  const fields = {};
  metaobject.fields.forEach((field) => {
    fields[field.key] = field.value;
  });

  return { id: metaobject.id, handle: metaobject.handle, updatedAt: metaobject.updatedAt, fields };
}

async function listServiceRequests(env) {
  const data = await shopifyAdminGraphQL(
    env,
    `query ListServiceRequests($type: String!) {
      metaobjects(type: $type, first: 50) {
        edges {
          node {
            handle
            updatedAt
            fields { key value }
          }
        }
      }
    }`,
    { type: SERVICE_REQUEST_METAOBJECT_TYPE }
  );

  return (data.metaobjects.edges || [])
    .map(({ node }) => {
      const fields = {};
      node.fields.forEach((field) => {
        fields[field.key] = field.value;
      });
      return { handle: node.handle, updatedAt: node.updatedAt, fields };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

async function upsertServiceRequest(env, handle, fields) {
  const data = await shopifyAdminGraphQL(
    env,
    `mutation ServiceRequestUpdate($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
        metaobject { id handle }
        userErrors { field message code }
      }
    }`,
    {
      handle: { type: SERVICE_REQUEST_METAOBJECT_TYPE, handle },
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

/*
 * Public tracking lookup — replaces the theme's old direct Storefront
 * API query. Called from sections/repair-tracker.liquid on every
 * "Track repair" submit. Checks the Repair ID + phone-last-4 against
 * BOTH metaobject types server-side (something the browser can never
 * safely do for `sethi_service_request`, since that one carries the
 * customer's name/phone/email and has no Storefront access):
 *
 *   1. `sethi_repair_job` first — the richer, staff-maintained record.
 *      If it exists and the phone matches, return its fields as-is
 *      (nothing in this metaobject is customer-PII by design).
 *   2. Otherwise `sethi_service_request` — the raw online booking, for
 *      the window between a customer submitting and staff promoting it
 *      via /staff/promote. Only a small customer-safe field subset is
 *      returned here, never full_name/phone/email/serial_number/etc.
 *
 * Either way, a mismatch (wrong ID, wrong phone, or nothing at all)
 * returns the exact same generic response, so the failure never reveals
 * which part was wrong.
 */
async function handleTrack(request, env) {
  const body = await request.json();
  const handle = (body.handle || '').toLowerCase().trim();
  const phoneLast4 = (body.phone_last4 || '').trim();

  if (!isValidHandle(handle) || !/^[0-9]{4}$/.test(phoneLast4)) {
    return json({ ok: false, error: 'Not found' }, 404);
  }

  const job = await getRepairJob(env, handle);
  if (job && job.fields.contact_phone_last4 === phoneLast4) {
    return json(
      { ok: true, kind: 'repair_job', handle: job.handle, fields: job.fields, updated_at: job.updatedAt },
      200
    );
  }

  const serviceRequest = await getServiceRequest(env, handle);
  if (serviceRequest && serviceRequest.fields.contact_phone_last4 === phoneLast4) {
    const sr = serviceRequest.fields;
    return json(
      {
        ok: true,
        kind: 'service_request',
        handle: serviceRequest.handle,
        fields: {
          status: sr.status,
          submitted_at: sr.submitted_at,
          watch_brand: sr.watch_brand,
          watch_model: sr.watch_model,
          service_type: sr.service_type,
          preferred_store: sr.preferred_store,
          issue_description: sr.issue_description
        },
        updated_at: serviceRequest.updatedAt
      },
      200
    );
  }

  return json({ ok: false, error: 'Not found' }, 404);
}

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

/*
 * Shopify webhook — topics METAOBJECTS_CREATE / METAOBJECTS_UPDATE.
 * Keeps `status_history_log` in sync with `status` no matter HOW status
 * was changed — through /staff/update-status (which already appends a
 * matching log line itself), or by a staff member editing the Status
 * field directly on the metaobject entry in Shopify Admin (which has no
 * way to also append to the log, since that's just an ordinary text
 * field to Admin). Whenever a `sethi_repair_job` is created or updated
 * and its log's last line doesn't already say the current status, this
 * appends one that does.
 *
 * Both topics point at the same handler. The webhook payload for a
 * metaobject already includes `type`, `handle` and `fields` (as a plain
 * {key: value} object) directly — no need to re-fetch via the Admin
 * API. Register with:
 *   webhookSubscriptionCreate(topic: METAOBJECTS_CREATE, webhookSubscription: { callbackUrl: "{this worker's URL}/webhook/metaobject", filter: "type:sethi_repair_job" })
 *   webhookSubscriptionCreate(topic: METAOBJECTS_UPDATE, webhookSubscription: { callbackUrl: "{this worker's URL}/webhook/metaobject", filter: "type:sethi_repair_job" })
 * (handleStaffRegisterWebhooks below does this for you.) See README.md.
 *
 * Re-entrancy: writing the backfilled log line is itself an update, so
 * it re-triggers this same webhook — but by then the log's last line
 * already matches `status`, so that second call is a no-op. The `filter`
 * on the subscription itself already limits delivery to this one
 * metaobject type, but the type check below is kept as a defensive
 * second layer.
 */
async function handleMetaobjectWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('X-Shopify-Hmac-Sha256') || '';

  const isValid = await verifyShopifyWebhookSignature(env, rawBody, signature);
  if (!isValid) return json({ ok: false, error: 'Invalid webhook signature' }, 401);

  const payload = JSON.parse(rawBody);
  if (payload.type !== METAOBJECT_TYPE) {
    return json({ ok: true, skipped: true }, 200);
  }

  const handle = (payload.handle || '').toLowerCase();
  const fields = payload.fields || {};
  if (!isValidHandle(handle)) return json({ ok: true, skipped: true }, 200);

  const status = fields.status;
  if (!status) return json({ ok: true, skipped: true }, 200);

  const log = fields.status_history_log || '';
  const lastLine = log.split('\n').filter((line) => line.trim().length > 0).pop() || '';
  // A line looks like "17 Sept 2026: Some status — optional extra context".
  // Compare only the status portion, so extra context after "—" (added by
  // /staff/update-status or the auto-create step) doesn't cause a false
  // mismatch here.
  const lastLoggedStatus = lastLine.replace(/^[^:]*:\s*/, '').split(' — ')[0].trim();

  if (lastLoggedStatus === status) {
    // Already reflects the current status — either nothing changed, or
    // this is the re-trigger from our own write just below. Stop here.
    return json({ ok: true, skipped: true }, 200);
  }

  const newLog = log ? `${log}\n${formatLogDate()}: ${status}` : `${formatLogDate()}: ${status}`;
  const updateFields = { status_history_log: newLog };

  // Never overwrite a staff-written note — only fill it in if it's
  // genuinely blank, so the "Latest update" card isn't empty after a
  // status-only edit made directly in Admin.
  if (!fields.latest_update_note) {
    updateFields.latest_update_note = `Status updated: ${status}`;
    updateFields.customer_facing_summary = updateFields.latest_update_note;
  }

  await upsertRepairJob(env, handle, updateFields);

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
 * review it in Shopify Admin and, once verified, turn it into the
 * matching `sethi_repair_job` via the /staff page (see handleStaffPromote
 * below) — that's also why this only ever creates "New" requests and
 * never a Repair ID directly: the copy on that page is explicit that a
 * Repair ID is issued only after staff verification. `status` goes to
 * "Converted" (written by handleStaffPromote) once that's happened, so
 * the /staff page's request list knows not to offer it again.
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
  // Shopify's metaobject fields reject empty strings ("can't be blank")
  // and its Admin UI doesn't expose a way to make an existing field
  // optional after creation, so these two (genuinely optional on the
  // form) get a placeholder instead of '' when left blank.
  const serialNumber = cleanString(body.serial_number, 100) || 'Not provided';
  const serviceType = cleanString(body.service_type, 60);
  const purchaseSource = cleanString(body.purchase_source, 60);
  const invoiceAvailable = cleanString(body.invoice_available, 10);
  const warrantyStatus = cleanString(body.warranty_status, 60);
  const preferredServiceMode = cleanString(body.preferred_service_mode, 60);
  const issueDescription = cleanString(body.issue_description, 1500);
  const conditionNotes = cleanString(body.condition_notes, 800) || 'Not provided';
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
      /*
        Immediately create the matching `sethi_repair_job` too, using the
        SAME handle — so the Repair ID on the confirmation screen is
        trackable (and visible/editable by admin under Content ->
        Metaobjects -> Repair Job) right away, not just once staff
        manually promote it. Judgement-call fields staff can't know yet
        (exact location, promised-by date, final cost) get placeholder
        defaults; `warranty_or_paid` is seeded from what the customer
        selected, since that's the best signal available until someone
        inspects the watch. Admin corrects any of this directly on the
        Repair Job entry, or via the /staff page.

        Non-fatal by design: if this fails, the customer's booking still
        succeeded (the service request above was already saved), and
        /track's fallback to `sethi_service_request` (see handleTrack)
        keeps that Repair ID trackable in the meantime.
      */
      try {
        const repairJobFields = buildRepairJobFieldsFromServiceRequest(
          { ...fields, request_id: requestId },
          {
            status: 'Received at counter',
            currentLocation: preferredStore || 'Our counter',
            warrantyOrPaid: warrantyStatus === 'Under manufacturer warranty' ? 'Warranty' : 'Chargeable',
            latestUpdateNote:
              'Online booking received. Our team will confirm your drop-off or pickup details shortly.',
            logSuffix: `online booking received (${serviceType || 'service request'})`
          }
        );
        await upsertRepairJob(env, requestId.toLowerCase(), repairJobFields);
        await upsertServiceRequest(env, requestId.toLowerCase(), { status: 'Converted' });
      } catch (err) {
        console.error('[repair-payments-worker] auto-create repair job failed:', err);
      }

      return json({ ok: true, request_id: requestId }, 200);
    }

    const isHandleTaken = userErrors.some(
      (e) => e.code === 'TAKEN' || /already exists|has already been taken/i.test(e.message)
    );
    if (!isHandleTaken) {
      // Include each error's field path (e.g. ["fields","serial_number"])
      // so a bad metaobject definition setting can be spotted immediately
      // from the response, instead of guessing which of the ~19 fields it is.
      throw new Error(
        userErrors.map((e) => `${e.message}${e.field ? ` (field: ${e.field.join('.')})` : ''}`).join('; ')
      );
    }
    // else loop and try another generated id
  }

  throw new Error('Could not generate a unique request ID after several attempts');
}

/* ---------------------------------------------------------------------- */

/*
 * STAFF TOOLING — turns a `sethi_service_request` (raw online booking)
 * into a trackable, payable `sethi_repair_job`, and updates one
 * afterwards. See the "STAFF WORKFLOW" comment near the top of this
 * file. All four endpoints below require the X-Staff-Key header to
 * match STAFF_API_KEY (checked in the router, not here).
 */

async function handleStaffListServiceRequests(env) {
  const requests = await listServiceRequests(env);
  return json({ ok: true, requests }, 200);
}

async function handleStaffGetServiceRequest(request, env) {
  const body = await request.json();
  const handle = (body.request_id || '').toLowerCase();
  if (!isValidHandle(handle)) return json({ ok: false, error: 'Invalid request ID' }, 400);

  const serviceRequest = await getServiceRequest(env, handle);
  if (!serviceRequest) return json({ ok: false, error: 'Service request not found' }, 404);

  return json({ ok: true, handle: serviceRequest.handle, fields: serviceRequest.fields }, 200);
}

async function handleStaffGetRepairJob(request, env) {
  const body = await request.json();
  const handle = (body.handle || '').toLowerCase();
  if (!isValidHandle(handle)) return json({ ok: false, error: 'Invalid handle' }, 400);

  const job = await getRepairJob(env, handle);
  if (!job) return json({ ok: false, error: 'Repair job not found' }, 404);

  return json({ ok: true, handle: job.handle, fields: job.fields }, 200);
}

/*
 * Creates the `sethi_repair_job` metaobject for a service request, using
 * the SAME handle (and therefore the same Repair ID + phone-last-4 the
 * customer already has from their booking confirmation) — so nothing
 * new needs to be issued to the customer. Customer-safe fields are
 * copied over from the service request; the rest (status, location,
 * estimate, warranty/paid) are whatever staff enter on the /staff page,
 * since those reflect the physical inspection that's only happened now.
 */
async function handleStaffPromote(request, env) {
  const body = await request.json();
  const requestId = cleanString(body.request_id, 40);
  const handle = requestId.toLowerCase();
  if (!isValidHandle(handle)) return json({ ok: false, error: 'Invalid request ID' }, 400);

  const status = body.status;
  if (!REPAIR_JOB_STATUS_OPTIONS.includes(status)) {
    return json({ ok: false, error: 'Please choose a valid status.' }, 400);
  }
  const warrantyOrPaid = body.warranty_or_paid;
  if (!isNonBlank(warrantyOrPaid)) {
    return json({ ok: false, error: 'Please enter warranty/chargeable status.' }, 400);
  }

  const existingJob = await getRepairJob(env, handle);
  if (existingJob) {
    return json(
      { ok: false, error: 'A repair job already exists for this request ID — use "Update repair job" instead.' },
      409
    );
  }

  const serviceRequest = await getServiceRequest(env, handle);
  if (!serviceRequest) return json({ ok: false, error: 'Service request not found' }, 404);
  const sr = serviceRequest.fields;

  const fields = buildRepairJobFieldsFromServiceRequest(sr, {
    status,
    currentLocation: cleanString(body.current_location, 120) || 'Our counter',
    promisedByDate: cleanString(body.promised_by_date, 40),
    warrantyOrPaid,
    estimatedCost: body.estimated_cost,
    latestUpdateNote: cleanString(body.latest_update_note, 200),
    logSuffix: `job created from online service request (${sr.service_type || 'service request'})`
  });

  await upsertRepairJob(env, handle, fields);

  // So this request doesn't show up as "open" on the /staff page again.
  await upsertServiceRequest(env, handle, { status: 'Converted' });

  return json(
    { ok: true, handle, tracking_id: requestId.toUpperCase(), phone_last4: sr.contact_phone_last4 || '' },
    200
  );
}

/*
 * Updates an existing `sethi_repair_job` — status, location, dates,
 * cost, warranty/paid, and the customer-facing note. `new_log_line`, if
 * given, is APPENDED to status_history_log (with today's date) rather
 * than replacing it — matching the Admin field's own instruction to
 * never delete old lines, since that log is the customer's timeline.
 */
async function handleStaffUpdate(request, env) {
  const body = await request.json();
  const handle = (body.handle || '').toLowerCase();
  if (!isValidHandle(handle)) return json({ ok: false, error: 'Invalid handle' }, 400);

  const job = await getRepairJob(env, handle);
  if (!job) return json({ ok: false, error: 'Repair job not found' }, 404);

  const fields = {};

  if (body.status !== undefined) {
    if (!REPAIR_JOB_STATUS_OPTIONS.includes(body.status)) {
      return json({ ok: false, error: 'Please choose a valid status.' }, 400);
    }
    fields.status = body.status;
  }
  if (body.warranty_or_paid !== undefined) {
    if (!isNonBlank(body.warranty_or_paid)) {
      return json({ ok: false, error: 'Please enter warranty/chargeable status.' }, 400);
    }
    fields.warranty_or_paid = body.warranty_or_paid;
  }
  if (body.current_location) fields.current_location = cleanString(body.current_location, 120);
  if (body.promised_by_date) fields.promised_by_date = cleanString(body.promised_by_date, 40);
  if (body.accessories_received) fields.accessories_received = cleanString(body.accessories_received, 300);
  if (body.condition_on_arrival) fields.condition_on_arrival = cleanString(body.condition_on_arrival, 500);

  if (body.estimated_cost !== undefined && body.estimated_cost !== '') {
    const estimatedCost = parseFloat(body.estimated_cost);
    if (!Number.isNaN(estimatedCost) && estimatedCost >= 0) fields.estimated_cost = String(estimatedCost);
  }
  if (body.approved_cost !== undefined && body.approved_cost !== '') {
    const approvedCost = parseFloat(body.approved_cost);
    if (!Number.isNaN(approvedCost) && approvedCost >= 0) fields.approved_cost = String(approvedCost);
  }

  if (body.latest_update_note) {
    const note = cleanString(body.latest_update_note, 200);
    fields.latest_update_note = note;
    fields.customer_facing_summary = note;
  }

  if (body.new_log_line) {
    const line = cleanString(body.new_log_line, 300);
    const existingLog = job.fields.status_history_log || '';
    fields.status_history_log = existingLog ? `${existingLog}\n${formatLogDate()}: ${line}` : `${formatLogDate()}: ${line}`;
  }

  if (!Object.keys(fields).length) {
    return json({ ok: false, error: 'Nothing to update.' }, 400);
  }

  await upsertRepairJob(env, handle, fields);
  return json({ ok: true, handle }, 200);
}

/*
 * One-time (idempotent) setup helper: registers the three webhook
 * subscriptions this worker needs (DRAFT_ORDERS_UPDATE for payment
 * confirmation, METAOBJECTS_CREATE/METAOBJECTS_UPDATE for the status
 * log backfill above), pointed at THIS deployment's own URL. Safe to
 * call more than once — it lists what's already registered first and
 * only creates what's missing, so re-running it after a redeploy (same
 * URL) is a no-op. Exists so this can be done from the worker's own
 * already-authenticated Admin API session instead of hand-running
 * GraphQL mutations with credentials pasted into a terminal.
 */
async function handleStaffRegisterWebhooks(request, env) {
  const origin = new URL(request.url).origin;
  const desired = [
    { topic: 'DRAFT_ORDERS_UPDATE', callbackUrl: `${origin}/webhook` },
    {
      topic: 'METAOBJECTS_CREATE',
      callbackUrl: `${origin}/webhook/metaobject`,
      filter: `type:${METAOBJECT_TYPE}`
    },
    {
      topic: 'METAOBJECTS_UPDATE',
      callbackUrl: `${origin}/webhook/metaobject`,
      filter: `type:${METAOBJECT_TYPE}`
    }
  ];

  const existingData = await shopifyAdminGraphQL(
    env,
    `query ExistingWebhooks {
      webhookSubscriptions(first: 50) {
        edges { node { id topic callbackUrl } }
      }
    }`,
    {}
  );
  const existing = (existingData.webhookSubscriptions.edges || []).map((edge) => edge.node);

  const results = [];
  for (const item of desired) {
    const alreadyRegistered = existing.some(
      (w) => w.topic === item.topic && w.callbackUrl === item.callbackUrl
    );
    if (alreadyRegistered) {
      results.push({ topic: item.topic, callbackUrl: item.callbackUrl, status: 'already registered' });
      continue;
    }

    const webhookSubscription = { callbackUrl: item.callbackUrl, format: 'JSON' };
    if (item.filter) webhookSubscription.filter = item.filter;

    const data = await shopifyAdminGraphQL(
      env,
      `mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
          webhookSubscription { id topic callbackUrl }
          userErrors { field message }
        }
      }`,
      { topic: item.topic, webhookSubscription }
    );

    const userErrors = data.webhookSubscriptionCreate.userErrors;
    if (userErrors?.length) {
      results.push({
        topic: item.topic,
        callbackUrl: item.callbackUrl,
        status: 'error',
        error: userErrors.map((e) => e.message).join('; ')
      });
    } else {
      results.push({ topic: item.topic, callbackUrl: item.callbackUrl, status: 'created' });
    }
  }

  return json({ ok: true, results }, 200);
}

/*
 * Minimal internal tool for staff: lists open online service requests,
 * turns one into a trackable repair job (POST /staff/promote), and
 * updates an existing repair job's status/estimate (POST
 * /staff/update-status). No build step, no framework — this is small
 * enough to stay a single inline page served by the worker itself.
 * Never linked from the storefront theme; only staff who have the URL
 * and the key can reach it.
 */
const STAFF_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sethi Watch — Repair staff tool</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px 16px 80px;
    background: #f4f1ec;
    color: #171513;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .sub { color: #6b6560; margin: 0 0 24px; }
  .wrap { max-width: 760px; margin: 0 auto; }
  .card {
    background: #fff;
    border: 1px solid rgba(23,21,19,0.1);
    border-radius: 6px;
    padding: 18px;
    margin-bottom: 20px;
  }
  label { display: block; font-size: 11px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase; color: #6b6560; margin: 12px 0 4px; }
  label:first-child { margin-top: 0; }
  input, select, textarea, button {
    font: inherit;
    width: 100%;
    padding: 9px 10px;
    border: 1px solid rgba(23,21,19,0.2);
    border-radius: 4px;
    background: #fff;
  }
  textarea { min-height: 60px; resize: vertical; }
  button {
    background: #171513;
    color: #fff;
    border: 0;
    cursor: pointer;
    font-weight: 600;
    margin-top: 14px;
  }
  button.secondary { background: #fff; color: #171513; border: 1px solid rgba(23,21,19,0.3); }
  button:disabled { opacity: 0.6; cursor: wait; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .list-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid rgba(23,21,19,0.08);
  }
  .list-item:last-child { border-bottom: 0; }
  .list-item div strong { display: block; }
  .list-item div span { color: #6b6560; font-size: 12px; }
  .badge { font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 3px 7px; border-radius: 3px; background: rgba(23,21,19,0.08); }
  .badge.converted { background: rgba(60,130,80,0.15); color: #2c6b41; }
  .msg { margin-top: 12px; padding: 10px 12px; border-radius: 4px; font-size: 13px; display: none; }
  .msg.ok { display: block; background: rgba(60,130,80,0.12); color: #2c6b41; }
  .msg.err { display: block; background: rgba(180,50,40,0.1); color: #a3382b; }
  .hint { color: #6b6560; font-size: 12px; margin-top: 4px; }
  #keyGate { text-align: center; padding: 60px 16px; }
  #keyGate input { max-width: 320px; margin: 0 auto; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
  <div id="keyGate">
    <h1>Sethi Watch — Repair staff tool</h1>
    <p class="sub">Enter the staff key to continue.</p>
    <input id="keyInput" type="password" placeholder="Staff key" autocomplete="off">
    <button id="keySave" style="max-width:320px;margin:10px auto 0;">Continue</button>
  </div>

  <div id="app" hidden>
    <h1>Repair staff tool</h1>
    <p class="sub">Turn an online service request into a trackable repair job, or update one already in progress. <a href="#" id="signOut">Change key</a></p>

    <div class="card">
      <h2>Open service requests</h2>
      <button id="loadRequests" class="secondary">Load requests</button>
      <div id="requestList" style="margin-top:8px;"></div>
    </div>

    <div class="card" id="promoteCard" hidden>
      <h2>Create repair job from request <span id="promoteReqId"></span></h2>
      <label>Status</label>
      <select id="pStatus"></select>
      <div class="row">
        <div>
          <label>Current location</label>
          <input id="pLocation" placeholder="Our counter">
        </div>
        <div>
          <label>Promised-by date</label>
          <input id="pPromised" type="date">
        </div>
      </div>
      <div class="row">
        <div>
          <label>Estimated cost (INR, optional)</label>
          <input id="pEstimate" type="number" min="0" step="1">
        </div>
        <div>
          <label>Warranty or chargeable</label>
          <input id="pWarranty" placeholder="Warranty or Chargeable">
        </div>
      </div>
      <p class="hint">Type exactly what your Repair Job's "warranty_or_paid" field expects — only the literal value "Warranty" gets special handling on the tracker; anything else is treated as a paid/chargeable repair.</p>
      <label>Note shown to customer</label>
      <textarea id="pNote" placeholder="e.g. Watch received, movement being inspected."></textarea>
      <button id="pSubmit">Create repair job</button>
      <div class="msg" id="pMsg"></div>
    </div>

    <div class="card">
      <h2>Update an existing repair job</h2>
      <label>Repair tracking ID</label>
      <input id="uHandle" placeholder="e.g. SWR-REQ-260917-9857">
      <button id="uLoad" class="secondary">Load</button>
      <div id="uForm" hidden>
        <label>Status</label>
        <select id="uStatus"></select>
        <div class="row">
          <div>
            <label>Current location</label>
            <input id="uLocation">
          </div>
          <div>
            <label>Promised-by date</label>
            <input id="uPromised" type="date">
          </div>
        </div>
        <div class="row">
          <div>
            <label>Estimated cost (INR)</label>
            <input id="uEstimate" type="number" min="0" step="1">
          </div>
          <div>
            <label>Approved cost (INR)</label>
            <input id="uApproved" type="number" min="0" step="1">
          </div>
        </div>
        <label>Warranty or chargeable</label>
        <input id="uWarranty" placeholder="Warranty or Chargeable">
        <label>Note shown to customer (latest update)</label>
        <textarea id="uNote"></textarea>
        <label>Add a line to the update history</label>
        <textarea id="uLogLine" placeholder="e.g. Parts received, reassembly in progress."></textarea>
        <p class="hint" id="uExistingLog"></p>
        <button id="uSubmit">Save changes</button>
        <div class="msg" id="uMsg"></div>
      </div>
    </div>
  </div>
</div>

<script>
(() => {
  const STATUS_OPTIONS = ${JSON.stringify(REPAIR_JOB_STATUS_OPTIONS)};
  const KEY_STORAGE = 'sethiStaffKey';

  const $ = (id) => document.getElementById(id);
  const keyGate = $('keyGate');
  const app = $('app');

  const getKey = () => {
    try { return window.localStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
  };
  const setKey = (value) => {
    try { window.localStorage.setItem(KEY_STORAGE, value); } catch (e) { /* ignore */ }
  };
  const clearKey = () => {
    try { window.localStorage.removeItem(KEY_STORAGE); } catch (e) { /* ignore */ }
  };

  const api = async (path, body) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Staff-Key': getKey() },
      body: JSON.stringify(body || {})
    });
    const data = await response.json();
    if (response.status === 401) { showGate(); throw new Error('Staff key rejected — please re-enter it.'); }
    if (!data.ok) throw new Error(data.error || 'Request failed');
    return data;
  };

  const showGate = () => { keyGate.hidden = false; app.hidden = true; };
  const showApp = () => { keyGate.hidden = true; app.hidden = false; };

  $('keySave').addEventListener('click', () => {
    const value = $('keyInput').value.trim();
    if (!value) return;
    setKey(value);
    showApp();
  });
  $('signOut').addEventListener('click', (event) => {
    event.preventDefault();
    clearKey();
    $('keyInput').value = '';
    showGate();
  });

  if (getKey()) showApp(); else showGate();

  [$('pStatus'), $('uStatus')].forEach((select) => {
    STATUS_OPTIONS.forEach((status) => {
      const option = document.createElement('option');
      option.value = status;
      option.textContent = status;
      select.appendChild(option);
    });
  });

  const showMsg = (el, text, isError) => {
    el.textContent = text;
    el.className = 'msg ' + (isError ? 'err' : 'ok');
  };

  let selectedRequest = null;

  $('loadRequests').addEventListener('click', async () => {
    const list = $('requestList');
    list.textContent = 'Loading…';
    try {
      const data = await api('/staff/service-requests', {});
      list.innerHTML = '';
      if (!data.requests.length) {
        list.textContent = 'No service requests yet.';
        return;
      }
      data.requests.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'list-item';
        const converted = r.fields.status === 'Converted';
        row.innerHTML =
          '<div><strong>' + r.handle.toUpperCase() + '</strong>' +
          '<span>' + (r.fields.full_name || '') + ' · ' + (r.fields.watch_brand || '') + ' ' + (r.fields.watch_model || '') +
          ' · phone ···' + (r.fields.contact_phone_last4 || '') + '</span></div>';
        const action = document.createElement(converted ? 'span' : 'button');
        if (converted) {
          action.className = 'badge converted';
          action.textContent = 'Converted';
        } else {
          action.className = 'badge';
          action.textContent = 'Create repair job';
          action.style.cursor = 'pointer';
          action.addEventListener('click', () => openPromote(r));
        }
        row.appendChild(action);
        list.appendChild(row);
      });
    } catch (err) {
      list.textContent = err.message;
    }
  });

  const openPromote = (r) => {
    selectedRequest = r;
    $('promoteReqId').textContent = r.handle.toUpperCase();
    $('pStatus').value = 'Received at counter';
    $('pLocation').value = 'Our counter';
    $('pPromised').value = '';
    $('pEstimate').value = '';
    $('pWarranty').value = 'Chargeable';
    $('pNote').value = 'Watch received — inspection in progress.';
    $('pMsg').className = 'msg';
    $('promoteCard').hidden = false;
    $('promoteCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  $('pSubmit').addEventListener('click', async () => {
    if (!selectedRequest) return;
    const button = $('pSubmit');
    button.disabled = true;
    try {
      const data = await api('/staff/promote', {
        request_id: selectedRequest.handle,
        status: $('pStatus').value,
        current_location: $('pLocation').value,
        promised_by_date: $('pPromised').value,
        estimated_cost: $('pEstimate').value,
        warranty_or_paid: $('pWarranty').value,
        latest_update_note: $('pNote').value
      });
      showMsg(
        $('pMsg'),
        'Repair job created. Give the customer their existing Repair ID ' + data.tracking_id +
          ' and phone last 4 digits ' + data.phone_last4 + ' — same as their booking confirmation, nothing new to send.',
        false
      );
      $('loadRequests').click();
    } catch (err) {
      showMsg($('pMsg'), err.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $('uLoad').addEventListener('click', async () => {
    const handle = $('uHandle').value.trim().toLowerCase();
    if (!handle) return;
    try {
      const data = await api('/staff/repair-job', { handle });
      const f = data.fields;
      $('uStatus').value = f.status || STATUS_OPTIONS[0];
      $('uLocation').value = f.current_location || '';
      $('uPromised').value = (f.promised_by_date || '').slice(0, 10);
      $('uEstimate').value = f.estimated_cost || '';
      $('uApproved').value = f.approved_cost || '';
      $('uWarranty').value = f.warranty_or_paid || '';
      $('uNote').value = f.latest_update_note || '';
      $('uLogLine').value = '';
      $('uExistingLog').textContent = f.status_history_log
        ? 'Existing history:\\n' + f.status_history_log
        : 'No history logged yet.';
      $('uForm').hidden = false;
      $('uMsg').className = 'msg';
    } catch (err) {
      $('uForm').hidden = true;
      alert(err.message);
    }
  });

  $('uSubmit').addEventListener('click', async () => {
    const handle = $('uHandle').value.trim().toLowerCase();
    if (!handle) return;
    const button = $('uSubmit');
    button.disabled = true;
    try {
      await api('/staff/update-status', {
        handle,
        status: $('uStatus').value,
        current_location: $('uLocation').value,
        promised_by_date: $('uPromised').value,
        estimated_cost: $('uEstimate').value,
        approved_cost: $('uApproved').value,
        warranty_or_paid: $('uWarranty').value,
        latest_update_note: $('uNote').value,
        new_log_line: $('uLogLine').value
      });
      showMsg($('uMsg'), 'Saved.', false);
      $('uLoad').click();
    } catch (err) {
      showMsg($('uMsg'), err.message, true);
    } finally {
      button.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;

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

    if (url.pathname === '/webhook/metaobject' && request.method === 'POST') {
      try {
        const result = await handleMetaobjectWebhook(request, env);
        return result;
      } catch (err) {
        console.error('[repair-payments-worker] metaobject webhook error', err);
        return json({ ok: false, error: 'Internal error' }, 500);
      }
    }

    // The staff tool page itself — same-origin JS calls the /staff/*
    // endpoints below with the key the staff member pastes in once.
    if (url.pathname === '/staff' && request.method === 'GET') {
      return new Response(STAFF_PAGE_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405, headers);
    }

    const STAFF_ROUTES = new Set([
      '/staff/service-requests',
      '/staff/service-request',
      '/staff/repair-job',
      '/staff/promote',
      '/staff/update-status',
      '/staff/register-webhooks'
    ]);
    if (STAFF_ROUTES.has(url.pathname) && !isStaffAuthorized(request, env)) {
      return json({ ok: false, error: 'Unauthorized' }, 401, headers);
    }

    try {
      let result;
      if (url.pathname === '/track') {
        result = await handleTrack(request, env);
      } else if (url.pathname === '/decision') {
        result = await handleDecision(request, env);
      } else if (url.pathname === '/create-order') {
        result = await handleCreateOrder(request, env);
      } else if (url.pathname === '/intake') {
        result = await handleIntake(request, env);
      } else if (url.pathname === '/staff/service-requests') {
        result = await handleStaffListServiceRequests(env);
      } else if (url.pathname === '/staff/service-request') {
        result = await handleStaffGetServiceRequest(request, env);
      } else if (url.pathname === '/staff/repair-job') {
        result = await handleStaffGetRepairJob(request, env);
      } else if (url.pathname === '/staff/promote') {
        result = await handleStaffPromote(request, env);
      } else if (url.pathname === '/staff/update-status') {
        result = await handleStaffUpdate(request, env);
      } else if (url.pathname === '/staff/register-webhooks') {
        result = await handleStaffRegisterWebhooks(request, env);
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
