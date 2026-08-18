# Sethi Watch — repair approval & payment backend

This is a small Cloudflare Worker. It's the only piece of the repair
approve/decline/pay feature that needs a real server — everything else
lives in the theme (`sections/repair-tracker.liquid`).

**This folder is intentionally separate from the theme.** It is not one of
Shopify's recognised theme directories, so the GitHub → Shopify theme
sync should ignore it — but treat it as its own deploy target, not
something that rides along with theme pushes. Consider moving it to its
own repository once it's working.

## How payment actually works here

This does **not** talk to Razorpay directly, and needs no Razorpay
credentials at all. Your store's checkout already has Razorpay (and
Snapmint, and cards) configured as payment methods — so this worker
creates a **Shopify Draft Order** for the repair's approved cost and
sends the customer to its real Shopify checkout URL. They pay however
they like, using whatever's already set up there. Shopify then tells
this worker the order was paid via a webhook, and that's what marks the
repair job as paid — never a client-side "success" callback.

Three endpoints:
- `POST /decision` — records a customer's "don't repair" decision.
- `POST /create-order` — creates a Draft Order for a repair job's own
  `estimated_cost` (read from Shopify, never trusted from the browser)
  and returns its checkout URL.
- `POST /webhook` — receives Shopify's `orders/paid` event, and marks
  the matching repair job as paid.

## One-time setup

### 1. A Shopify custom app
In Shopify Admin: Settings → Apps and sales channels → Develop apps →
Create an app. Under **Configuration**, grant these Admin API scopes:
`read_metaobjects`, `write_metaobjects`, `read_draft_orders`,
`write_draft_orders`. Install the app.

- On the **API credentials** tab, reveal and copy the **Admin API
  access token** — this is `SHOPIFY_ADMIN_TOKEN`.
- On the same tab, copy the **Client secret** — this is
  `SHOPIFY_WEBHOOK_SECRET` (Shopify signs webhooks with it).

### 2. Install Wrangler and log in
```
npm install
npx wrangler login
```

### 3. Set the secrets
```
npx wrangler secret put SHOPIFY_STORE_DOMAIN        # e.g. f7b00a-eb.myshopify.com
npx wrangler secret put SHOPIFY_ADMIN_TOKEN
npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
npx wrangler secret put ALLOWED_ORIGIN              # e.g. https://sethiwatch.com
```
For `ALLOWED_ORIGIN`, use the exact origin the tracker page is served
from. Add more than one, comma-separated, if you need both the live
domain and a `*.myshopify.com` preview domain while testing.

### 4. Deploy
```
npx wrangler deploy
```
This prints a URL like `https://sethi-repair-payments.<your-subdomain>.workers.dev`.

### 5. Register the webhook
Ask whoever has Claude Code access to run this (it needs your Admin API
access — the app you just made can do it), or run it yourself via the
GraphQL Admin API / Shopify CLI:
```graphql
mutation {
  webhookSubscriptionCreate(
    topic: ORDERS_PAID
    webhookSubscription: { uri: "https://<your-worker-url>/webhook" }
  ) {
    webhookSubscription { id }
    userErrors { field message }
  }
}
```

### 6. Wire it up in the theme
In Shopify theme editor: open the Repair Tracker section → **Repair
approval & payment** → paste the deployed URL into **Payment backend
base URL**.

## Testing
Approve a repair on the tracker page. You should land on a real Shopify
checkout showing the repair as a line item, with the store's normal
payment methods (Razorpay Secure included). Complete a payment (use a
low real amount or a test scenario your payment methods support), then
check the Repair Job record in Shopify Admin — `Payment status` should
flip to `Paid` and `Payment order` should link straight to the order.

## Local development
```
npm run dev
```
