/*
 * Sethi Watch — repair approval & payment backend
 *
 * Implements the exact 3-endpoint contract documented in
 * sections/repair-tracker.liquid (search that file for "BACKEND CONTRACT").
 * This is the only piece of the repair-payment feature that needed a real
 * server: creating a Razorpay order and verifying a completed payment both
 * require the Razorpay Key Secret, and writing the result back to the
 * repair job requires a Shopify Admin API token — neither can ever be sent
 * to a customer's browser.
 *
 * Required secrets (set with `wrangler secret put <NAME>`):
 *   RAZORPAY_KEY_ID        - public key, starts with rzp_
 *   RAZORPAY_KEY_SECRET    - private key, from the same Razorpay API key pair
 *   SHOPIFY_STORE_DOMAIN   - e.g. sethiwatch.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN    - a custom app Admin API access token with the
 *                            read_metaobjects and write_metaobjects scopes
 *   ALLOWED_ORIGIN         - the storefront origin allowed to call this,
 *                            e.g. https://sethiwatch.com (comma-separate
 *                            more than one, e.g. also a *.myshopify.com
 *                            preview domain while testing)
 *
 * See README.md in this folder for step-by-step deploy instructions.
 */

const SHOPIFY_API_VERSION = '2026-07';
const METAOBJECT_TYPE = 'sethi_repair_job';

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
  const amountInPaise = Math.round(estimatedCost * 100);

  const razorpayAuth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const orderResponse = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${razorpayAuth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: amountInPaise,
      currency: 'INR',
      receipt: `repair-${handle}`,
      notes: { repair_job_handle: handle }
    })
  });

  const order = await orderResponse.json();
  if (!orderResponse.ok) {
    return json({ ok: false, error: order.error?.description || 'Razorpay order creation failed' }, 502);
  }

  return json(
    {
      ok: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: env.RAZORPAY_KEY_ID
    },
    200
  );
}

async function handleVerifyPayment(request, env) {
  const body = await request.json();
  const handle = (body.handle || '').toLowerCase();
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = body;

  if (!isValidHandle(handle)) return json({ ok: false, error: 'Invalid handle' }, 400);
  if (!orderId || !paymentId || !signature) {
    return json({ ok: false, error: 'Missing payment reference' }, 400);
  }

  const isValid = await verifyRazorpaySignature(env, `${orderId}|${paymentId}`, signature);
  if (!isValid) {
    return json({ ok: false, error: 'Payment signature could not be verified' }, 401);
  }

  const job = await getRepairJob(env, handle);
  if (!job) return json({ ok: false, error: 'Repair job not found' }, 404);

  await upsertRepairJob(env, handle, {
    customer_decision: 'Approved',
    payment_status: 'Paid',
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    customer_decision_at: new Date().toISOString()
  });

  return json({ ok: true }, 200);
}

async function verifyRazorpaySignature(env, payload, signature) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.RAZORPAY_KEY_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expected = [...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/*
 * Razorpay webhook (recommended, not required for the theme's own flow to
 * work): configure a "payment.captured" webhook in the Razorpay dashboard
 * pointing at {this worker}/webhook, with a webhook secret set as
 * RAZORPAY_WEBHOOK_SECRET, so a payment is still recorded even if the
 * customer closes the tab before the browser's own verify call completes.
 */
async function handleWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('X-Razorpay-Signature') || '';

  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    return json({ ok: false, error: 'Webhook not configured' }, 501);
  }

  const isValid = await verifyRazorpaySignature(
    { RAZORPAY_KEY_SECRET: env.RAZORPAY_WEBHOOK_SECRET },
    rawBody,
    signature
  );
  if (!isValid) return json({ ok: false, error: 'Invalid webhook signature' }, 401);

  const event = JSON.parse(rawBody);
  if (event.event !== 'payment.captured') return json({ ok: true, skipped: true }, 200);

  const payment = event.payload?.payment?.entity;
  const handle = payment?.notes?.repair_job_handle;
  if (!handle || !isValidHandle(handle)) return json({ ok: true, skipped: true }, 200);

  const job = await getRepairJob(env, handle);
  if (job && job.fields.payment_status !== 'Paid') {
    await upsertRepairJob(env, handle, {
      customer_decision: 'Approved',
      payment_status: 'Paid',
      razorpay_order_id: payment.order_id,
      razorpay_payment_id: payment.id,
      customer_decision_at: new Date().toISOString()
    });
  }

  return json({ ok: true }, 200);
}

/* ---------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405, headers);
    }

    const url = new URL(request.url);

    try {
      let result;
      if (url.pathname === '/decision') {
        result = await handleDecision(request, env);
      } else if (url.pathname === '/create-order') {
        result = await handleCreateOrder(request, env);
      } else if (url.pathname === '/verify-payment') {
        result = await handleVerifyPayment(request, env);
      } else if (url.pathname === '/webhook') {
        result = await handleWebhook(request, env);
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
