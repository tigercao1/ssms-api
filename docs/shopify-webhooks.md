# Shopify customer webhooks

`POST /webhooks/shopify` keeps the `customers` table in step with Shopify between scheduled syncs.

- Public route (no Supabase auth), throttled per client IP.
- Every delivery must carry `X-Shopify-Hmac-Sha256`, the base64 HMAC-SHA256 of the raw request body keyed with
  `SHOPIFY_CLIENT_SECRET`, and `X-Shopify-Shop-Domain` must be `<SHOPIFY_SHOP>.myshopify.com`. Otherwise the API
  answers 401. With either variable unset it answers 503.
- Topics `customers/create`, `customers/update` and `customers/delete` are applied; any other topic gets 200 and is
  ignored.
- Each delivery is recorded once per `X-Shopify-Webhook-Id` in `shopify_webhook_events`. A repeated id answers 200
  and changes nothing. Rows older than 30 days are pruned by the scheduled customer sync.
- Creates and updates only overwrite a customer when the payload's `updated_at` is newer than the stored one, so late
  or out-of-order deliveries cannot roll a row back.
- A delete sets `customers.shopify_deleted_at` (the row stays, because classes reference it). A later update clears
  it. Deleted customers are hidden from customer search and the booking picker unless `includeDeleted=true` is
  passed.
- A payload that can never be applied (for example an id outside the safe integer range) is recorded with its error
  and answered with 200, so Shopify does not retry it.

The scheduled sync (`CUSTOMER_SYNC_ENABLED=true`) still runs as the reconciliation job:

- The incremental pass reads changes since its own watermark (`customer_sync_status.incremental_since`, set to the
  start of the last successful run minus 2 minutes), so webhook writes cannot make it skip anything.
- Once every 24 hours it lists every Shopify customer id and soft-deletes local customers that are gone, restoring
  any that reappear. If Shopify lists fewer than half of the active local customers it stops, applies nothing and
  records the reason in `lastReconcileError`.

No new environment variables are needed.

## Subscription block

Add this to `shopify.app.toml`. TOML allows a single `[webhooks]` table, so if the linked file already has one,
replace it with this block.

```toml
[webhooks]
api_version = "2026-10"

  [[webhooks.subscriptions]]
  topics = [ "customers/create", "customers/update" ]
  uri = "https://ssms-api-vivid-brook-6788.fly.dev/webhooks/shopify"
  include_fields = [ "id", "admin_graphql_api_id", "first_name", "last_name", "email", "phone", "updated_at" ]

  [[webhooks.subscriptions]]
  topics = [ "customers/delete" ]
  uri = "https://ssms-api-vivid-brook-6788.fly.dev/webhooks/shopify"
```

`include_fields` keeps addresses, notes and tax data out of the payloads; `updated_at` must stay in the list.

## Registration runbook

Run these as a member of the store's Shopify organization, after the API that serves `/webhooks/shopify` is deployed.

1. In an empty working folder, pull the app's **current** configuration:

   ```sh
   shopify app config link --client-id <SHOPIFY_CLIENT_ID>
   ```

   Choose `ssnow-app` when asked. This writes `shopify.app.toml` from the live app version.
2. Add only the `[webhooks]` block above. Do not change `[access_scopes]`, `application_url`, redirect URLs or any
   other setting that `config link` wrote.
3. Create a new app version without releasing it:

   ```sh
   shopify app deploy --no-release
   ```

4. In the Dev Dashboard open ssnow-app → Versions, open the new version and check that its configuration differs from
   the released one only by the webhook API version and the three subscriptions.
5. Release that version from the Dev Dashboard (or run `shopify app release --version <version>`).
6. Confirm the subscriptions under Versions → Configuration → Subscriptions.

To undo, remove the `[[webhooks.subscriptions]]` entries and repeat steps 3 to 5.

## Testing

### Sample delivery with the Shopify CLI

`shopify app webhook trigger` sends Shopify's fixed sample payload, signed with the secret you pass. It does not touch
the store and is never retried. Point it at a local or dev API that has `SHOPIFY_SHOP` and `SHOPIFY_CLIENT_SECRET` set:

```sh
shopify app webhook trigger \
  --topic customers/update \
  --api-version 2026-10 \
  --delivery-method http \
  --address http://localhost:3000/webhooks/shopify \
  --client-secret <SHOPIFY_CLIENT_SECRET>
```

- A 200 with `{"outcome":"invalid"}` means the signature and shop check passed. The sample customer id
  (706405506930370084) is beyond the range the API accepts, so it is recorded with an error in
  `shopify_webhook_events` and no customer is written.
- A 401 with `Unexpected Shopify shop` means the sample was sent with a shop domain other than `SHOPIFY_SHOP`. Use the
  signed curl below instead.

### Signed curl

```sh
body='{"id":1001,"admin_graphql_api_id":"gid://shopify/Customer/1001","first_name":"ZZ","last_name":"Webhook Test","email":null,"phone":null,"updated_at":"2026-10-13T12:00:00-04:00"}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SHOPIFY_CLIENT_SECRET" -binary | base64)
curl -i http://localhost:3000/webhooks/shopify \
  -H 'Content-Type: application/json' \
  -H 'X-Shopify-Topic: customers/update' \
  -H "X-Shopify-Hmac-Sha256: $sig" \
  -H "X-Shopify-Shop-Domain: $SHOPIFY_SHOP.myshopify.com" \
  -H "X-Shopify-Webhook-Id: local-$(date +%s)" \
  --data-binary "$body"
```

Sending the same `X-Shopify-Webhook-Id` again answers `{"outcome":"duplicate"}`.

### End to end on the store

1. In the Shopify admin create a customer named "ZZ Webhook Test", edit it, then delete it.
2. Dev Dashboard → ssnow-app → Logs should show three deliveries answered with 200.
3. The customer should be missing from customer search and present, with `shopifyDeletedAt` set, in
   `GET /admin/customers?q=ZZ&includeDeleted=true`.

## Monitoring

`GET /admin/customers/sync-status` (admin token) reports:

| Field | Meaning |
|---|---|
| `lastWebhookAt` | When the last delivery was received |
| `webhooksLast24h` | Deliveries received in the last 24 hours |
| `incrementalSince` | Watermark the next incremental sync starts from |
| `lastReconcileAt` / `lastReconcileError` | Last daily deletion reconcile and why it stopped, if it did |
| `deletedCount` | Customers currently marked deleted in Shopify |

```sh
curl -H "Authorization: Bearer $ADMIN_JWT" https://ssms-api-vivid-brook-6788.fly.dev/admin/customers/sync-status
```

After registration, `lastWebhookAt` should move whenever a customer changes in Shopify.
