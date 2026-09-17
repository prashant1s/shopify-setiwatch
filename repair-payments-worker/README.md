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

Customer-facing endpoints:
- `POST /track` — looks up a Repair ID + phone-last-4 against
  `sethi_repair_job` first, falling back to `sethi_service_request` (a
  "request received, pending review" view with only a small customer-safe
  field subset) if no repair job has been created for it yet. This is
  what makes the ID from the booking confirmation trackable immediately,
  before any staff review — see the comment above `handleTrack` in
  `src/index.js`.
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
- `POST /intake` — stores a "Book watch service" online form submission
  (`sections/book-watch-service.liquid`) as a `sethi_service_request`
  metaobject, and returns a `request_id` reference to show the customer
  (e.g. `SWR-REQ-260917-9857`). It then **also creates the matching
  `sethi_repair_job`** with the same handle right away (status "Received
  at counter", `warranty_or_paid` seeded from what the customer selected,
  everything else copied over) — so that entry appears immediately under
  Content → Metaobjects → Repair Job for admin to open and correct the
  location/estimate/status. This second write is best-effort: if it
  fails, the booking itself still succeeds, and `/track`'s fallback to
  `sethi_service_request` (below) keeps the Repair ID trackable until
  someone runs `/staff/promote` for it manually.

Staff-only endpoints (require the `X-Staff-Key` header — see **Staff
tool** below):
- `GET /staff` — the staff tool page itself (HTML/JS, no build step).
- `POST /staff/service-requests` — lists recent `sethi_service_request`
  entries.
- `POST /staff/service-request` / `POST /staff/repair-job` — fetch one
  service request / repair job by handle, for the staff page to prefill
  its forms.
- `POST /staff/promote` — turns a service request into a `sethi_repair_job`
  metaobject, **reusing the same handle** (and therefore the same Repair
  ID and phone-last-4 the customer already has from their booking
  confirmation) — nothing new has to be issued to the customer. Also
  flips the originating request's `status` to `Converted`. Since
  `/intake` now creates this automatically for every new request, this
  is mainly for backfilling older `sethi_service_request` entries saved
  before that existed, or redoing one that failed to auto-create.
- `POST /staff/update-status` — updates an existing repair job's status,
  location, dates, estimate/approved cost, warranty-or-paid, and
  customer-facing note. It can append a new line to `status_history_log`
  without touching the existing lines.

## Staff tool

Once deployed (see setup below), every new online booking already shows
up as a `sethi_repair_job` in Shopify Admin (Content → Metaobjects →
Repair Job) the moment it's submitted — admin can open it there directly
and edit `status`/`estimated_cost`/etc. like any other metaobject entry.
`https://<your-worker-url>/staff` is there for doing the same without
leaving one page, and for the two cases Admin alone can't handle:

1. **Update an existing repair job** — loads any repair job by its
   tracking ID and lets you change its status/estimate or add a line to
   its update history (`/staff/update-status`), which correctly appends
   to `status_history_log` instead of overwriting it (editing that field
   by hand in Admin risks deleting earlier lines the customer already
   saw).
2. **Open service requests → Create repair job** — for a
   `sethi_service_request` that predates this auto-creation (or whose
   auto-create failed), calls `/staff/promote` to create its repair job
   now, reusing the same handle so the customer's existing Repair ID and
   phone-last-4 keep working.

This intentionally doesn't touch a separate "Repair Job — Private"
metaobject some stores also keep in Admin for internal-only notes
(technician, diagnosis) — that stays a manual, optional Admin-only
workflow if you use it; this tool and the tracker page only ever read
and write the public `sethi_repair_job` type.

## One-time setup

### 0. Create the `sethi_service_request` metaobject definition
Only needed for `/intake`. In Shopify Admin: **Content → Metaobjects →
Add definition**, type `sethi_service_request`, with these fields (all
"Single line text" except the two noted as "Multi-line text"):
`request_id`, `status`, `submitted_at`, `booking_source`, `full_name`,
`phone`, `contact_phone_last4`, `email`, `preferred_store`,
`watch_brand`, `watch_model`, `serial_number`, `service_type`,
`purchase_source`, `invoice_available`, `warranty_status`,
`preferred_service_mode`, `issue_description` (multi-line),
`condition_notes` (multi-line). No Storefront access needed — these are
staff-only, read through Shopify Admin (Content → Metaobjects) or the
Admin API this worker already authenticates with.

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
npx wrangler secret put STAFF_API_KEY               # make one up, e.g. `openssl rand -hex 24`
```
For `ALLOWED_ORIGIN`, use the exact origin the tracker page is served
from. Add more than one, comma-separated, if you need both the live
domain and a `*.myshopify.com` preview domain while testing.

`STAFF_API_KEY` gates every `/staff/*` endpoint and is the key staff
paste into the `/staff` page once (it's remembered in that browser via
localStorage). Treat it like a password — it's not shown to customers
anywhere, but anyone with it can create/edit repair jobs.

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
In Shopify theme editor:
- Repair Tracker section → **Repair backend connection** → paste the
  deployed URL into **Repair backend base URL**. This one URL now
  powers both tracking lookups (`/track`) and approve/decline/pay — the
  old separate Storefront API access token setting is gone, since
  `/track` reads through the Admin API server-side instead.
- Book watch service section → **Online request backend** → paste the
  same deployed URL into **Intake backend base URL**.

## Testing
Submit the "Book online" form on the Book watch service page. You
should see a success message with a request reference (e.g.
`SWR-REQ-260917-4821`). Check Shopify Admin under Content → Metaobjects
— you should now see BOTH a new `sethi_service_request` entry AND a
matching `Repair Job` entry with the same handle, status "Received at
counter". Open the Repair Job entry and set a real `estimated_cost` and
`current_location`.

Immediately track that same request ID + phone-last-4 on the tracker
page — it should show the full repair-job view (progress bar, estimate,
approve/pay) straight away, using whatever you just set in Admin.

**Backfilling older requests:** any `sethi_service_request` entries
saved before this worker version was deployed (like ones you created
while testing earlier) won't have a matching Repair Job yet. Open
`/staff`, enter the staff key, click **Load requests**, and click
**Create repair job** on each one — that calls `/staff/promote` to
create it now, reusing the same handle so the customer's existing
Repair ID and phone still work. Use the "Update an existing repair job"
box to change status afterwards and confirm the tracker reflects it (and
that `status_history_log` gains a new line without losing the old one).

Finally, approve a repair on the tracker page. You should land on a
real Shopify checkout showing the repair as a line item, with the
store's normal payment methods (Razorpay Secure included). Complete a
payment (use a low real amount or a test scenario your payment methods
support), then check the repair job record in Shopify Admin —
`Payment status` should flip to `Paid` and `Payment order` should link
straight to the order.

## Local development
```
npm run dev
```
