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
- `POST /webhook` — receives Shopify's `draft_orders/update` event, and
  when a draft order's status is `completed`, marks the matching repair
  job as paid. (This topic is used instead of `orders/paid` because it
  only needs the `read_draft_orders` scope — `orders/paid` needs
  `read_orders`, which typically requires Shopify's protected customer
  data approval.)

## One-time setup

### 1. Configure and install the Dev Dashboard app
The old "custom apps in Shopify admin" flow no longer exists (retired
Jan 2026) — apps are now built and installed through **Dev Dashboard**
(dev.shopify.com/dashboard). If you already created an app there (e.g.
one named "Repair tracker"), use it:

1. Open the app in Dev Dashboard → **Configuration** → grant these
   Admin API scopes: `read_metaobjects`, `write_metaobjects`,
   `read_draft_orders`, `write_draft_orders`. Save.
2. Go to the app's **Distribution** tab → choose **Custom distribution**
   → enter your store's domain → **Generate link**.
3. Open that install link in a browser signed in to your Shopify admin,
   and click **Install**. (The link expires after 7 days — regenerate if
   needed.)
4. Back in Dev Dashboard, open the app → **Settings** → copy the
   **Client ID** and **Client secret**. This worker uses those two
   values for everything — there's no separate static Admin API token
   to copy. Shopify also signs webhooks with the Client Secret, so it
   does double duty.

### 2. Install Wrangler and log in
```
npm install
npx wrangler login
```

### 3. Set the secrets
```
npx wrangler secret put SHOPIFY_STORE_DOMAIN        # e.g. f7b00a-eb.myshopify.com
npx wrangler secret put SHOPIFY_CLIENT_ID
npx wrangler secret put SHOPIFY_CLIENT_SECRET
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
access), or run it yourself via the GraphQL Admin API / Shopify CLI.
Use `DRAFT_ORDERS_UPDATE`, not `ORDERS_PAID` — this app only has the
`read_draft_orders` scope, and `ORDERS_PAID` needs `read_orders` (which
requires Shopify's protected customer data approval):
```graphql
mutation {
  webhookSubscriptionCreate(
    topic: DRAFT_ORDERS_UPDATE
    webhookSubscription: { uri: "https://<your-worker-url>/webhook" }
  ) {
    webhookSubscription { id topic uri }
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
