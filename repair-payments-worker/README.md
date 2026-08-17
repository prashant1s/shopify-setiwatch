# Sethi Watch — repair approval & payment backend

This is a small Cloudflare Worker. It's the only piece of the repair
approve/decline/pay feature that needs a real server — everything else
lives in the theme (`sections/repair-tracker.liquid`).

**This folder is intentionally separate from the theme.** It is not one of
Shopify's recognised theme directories (assets/config/layout/locales/
sections/snippets/templates), so the GitHub → Shopify theme sync should
ignore it — but treat it as its own deploy target, not something that
rides along with theme pushes. Consider moving it to its own repository
once it's working, so the two release cycles stay independent.

## What it does

Three endpoints, matching the contract documented in
`sections/repair-tracker.liquid`:

- `POST /decision` — records a customer's "don't repair" decision.
- `POST /create-order` — creates a Razorpay order for a repair job's own
  `estimated_cost` (read from Shopify, never trusted from the browser).
- `POST /verify-payment` — verifies a completed Razorpay payment's
  signature, then marks the repair job as paid in Shopify.
- `POST /webhook` (optional but recommended) — a Razorpay
  `payment.captured` webhook as a safety net, in case a customer closes
  the tab before the browser's own verify call finishes.

## One-time setup

### 1. Razorpay keys
In your Razorpay dashboard: Settings → API Keys → generate a **Live**
key pair (or a **Test** pair while you're still trying this out). You'll
get a Key ID (`rzp_...`) and a Key Secret. The Key Secret never leaves
this Worker.

### 2. A Shopify Admin API token
In Shopify Admin: Settings → Apps and sales channels → Develop apps →
Create an app. Under **Configuration**, grant the Admin API scopes
`read_metaobjects` and `write_metaobjects`. Install the app, then reveal
and copy its Admin API access token.

### 3. Install Wrangler and log in
```
npm install
npx wrangler login
```

### 4. Set the secrets
```
npx wrangler secret put RAZORPAY_KEY_ID
npx wrangler secret put RAZORPAY_KEY_SECRET
npx wrangler secret put SHOPIFY_STORE_DOMAIN        # e.g. sethiwatch.myshopify.com
npx wrangler secret put SHOPIFY_ADMIN_TOKEN
npx wrangler secret put ALLOWED_ORIGIN              # e.g. https://sethiwatch.com
```
For `ALLOWED_ORIGIN`, use the exact origin the tracker page is served
from. Add more than one, comma-separated, if you need both the live
domain and a `*.myshopify.com` preview domain while testing.

Optional, only if you set up the webhook (step 6):
```
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
```

### 5. Deploy
```
npx wrangler deploy
```
This prints a URL like `https://sethi-repair-payments.<your-subdomain>.workers.dev`.

### 6. Wire it up
- In Shopify theme editor: open the Repair Tracker section → **Repair
  approval & payment** → paste the deployed URL into **Payment backend
  base URL**, and your Razorpay **Key ID** (the public one) into
  **Razorpay Key ID**.
- (Optional but recommended) In Razorpay dashboard → Settings → Webhooks:
  add a webhook for the `payment.captured` event pointing at
  `{deployed URL}/webhook`, and set its secret to match
  `RAZORPAY_WEBHOOK_SECRET` above.

## Testing

Use Razorpay's **Test mode** keys first, and their published test card
numbers, before switching to Live keys. Approve a repair on the tracker
page and confirm the Repair Job record in Shopify Admin picks up
`Payment status = Paid` and both Razorpay ID fields.

## Local development
```
npm run dev
```
Wrangler will serve the Worker locally and print a local URL you can
point `payment_api_base_url` at temporarily for testing.
