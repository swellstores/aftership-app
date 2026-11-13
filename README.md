# AfterShip integration

A Swell app that sends Swell shipments to [AfterShip](https://www.aftership.com/) as trackings, and brings their delivery
status back to the order. AfterShip then tracks each parcel with the carrier and, if you've set them up in AfterShip, sends
its own branded notifications to the customer. The app connects with an AfterShip **API key** and receives status changes
through a signed AfterShip webhook, with an hourly refresh as a fallback.

## Features

### Connection

Every call goes to the AfterShip Tracking API, version `2026-07` (`https://api.aftership.com/tracking/2026-07`), with the
API key in the `as-api-key` header (`aftershipRequest` in `functions/lib/aftership.ts`). Errors keep AfterShip's meta code
(for example `4003` tracking already exists) and the refused call (for example `POST /trackings`), and are logged with both.

### Sending shipments

`functions/shipment-sync.ts` runs on `shipment.created` and `shipment.updated`. `shipment.updated` is handled only when
the change touches `tracking_code`, `carrier`, `carrier_name`, `packages`, `canceled` or `draft`, so the app's own writes
to the shipment don't trigger it again. The function receives the whole shipment; the changed fields are read from the
event (`$event.data`).

A shipment is sent when it isn't canceled or a draft and has a tracking number: its `tracking_code`, or, when it has
none, the first package `tracking_code` that's set. A shipment without a tracking number is skipped without a log or a line
on the order's AfterShip tab; it's sent once a number is added. The app remembers what it sent as `courier:number` (`synced`), and
sends the shipment again only when the tracking number or carrier changes.

The tracking (`POST /trackings`) has:

| AfterShip field | From Swell |
|---|---|
| `tracking_number` | the shipment's tracking number |
| `slug` | the courier, from the shipment's `carrier` (or `carrier_name`): `usps`, `ups`, `fedex`, `dhl_express` → `dhl`, `canada_post` → `canada-post`, `royal_mail` → `royal-mail` (and a few more known differences); any other name made of letters, digits, spaces, `_` or `-` is lowercased with spaces and `_` turned into `-`. When `carrier` is an app carrier (`app_…`), `carrier_name` is used. Left out when there's no usable name, and AfterShip detects the courier. |
| `title`, `order_id`, `order_number`, `order_date` | `Order #<number>`, the order ID, number and date |
| `order_id_path` | link to the order in the Swell dashboard: `https://<store>.swell.store/admin/orders/<id>`, or `/admin/test/...` in the test environment (the function's `Swell-Env` header is exactly `test`) |
| `tracking_ship_date` | when the shipment was created, as `YYYY-MM-DDTHH:mm:ss+00:00` (AfterShip rejects milliseconds; `order_date` is sent the same way) |
| `destination_country_region`, `destination_state`, `destination_city`, `destination_postal_code` | the shipment's destination (else the order's shipping address); the country as ISO alpha-3 |
| `shipment_tags` | the **Tags** setting |
| `custom_fields` | `swell_shipment_id` and `swell_order_id`, used to find the shipment when AfterShip sends an update |
| `customers` | with **Share customer contact** on: the customer's name, email (account, else billing) and phone in E.164 (left out when it can't be formatted); sent when there's an email or phone |

- **Tracking already in AfterShip** (meta code `4003`, for example from a retried event, the import, or the same number
  added in AfterShip directly): the app looks it up by number and courier (`GET /trackings?tracking_numbers=…&slug=…`)
  and links the shipment to it instead of creating a second one.
- **Courier refused** (`4010` invalid slug or `4012` bad courier): sent again without `slug`, so AfterShip detects the
  courier from the tracking number.
- **Tracking number changed**: a new tracking is created and the old one deleted. If deleting fails, the error is logged
  and the new tracking is still saved. If AfterShip refuses the new number, the old tracking is deleted too, and the
  shipment shows the reason.
- **Refused by AfterShip** (for example an invalid tracking number): the reason is saved on the shipment and shown on the
  order's AfterShip tab, and the shipment isn't sent again until its tracking number or carrier changes.

The shipment gets the tracking ID, courier, status, latest scan, estimated delivery and tracking page under
`$app.aftership` (`models/shipments.json`), and the order's **AfterShip** tab is updated (see below).

### Canceled and deleted shipments

With **Delete trackings of canceled shipments** on, `shipment.canceled` and `shipment.deleted` delete the AfterShip
tracking (`DELETE /trackings/{id}`), so AfterShip stops tracking the parcel and sending notifications. A tracking that's
already gone counts as deleted.

- A canceled shipment's tracking values are cleared, including `synced`, so the shipment is sent again if it's
  un-canceled.
- Swell sends `shipment.deleted` with only `$event`; the deleted shipment, with the app's values, is read from
  `$event.data`. If it has no tracking ID, the app looks the tracking up by number and deletes it only if its
  `swell_shipment_id` is that shipment.

### Tracking updates (webhook)

`functions/aftership-webhook.ts` is a public `POST` route for AfterShip's tracking webhook:

1. The `aftership-hmac-sha256` header must be the base64 HMAC-SHA256 of the raw request body with the **Webhook secret**.
   Requests without a valid signature, or while no secret is set, are rejected with `401`.
2. With **Enabled** off or no API key, the request is acknowledged with `{"received":true,"processed":false}` and nothing
   is called or saved.
3. Only `msg.id` is read from the payload. The tracking is loaded again from AfterShip with the API key
   (`GET /trackings/{id}`), so the payload itself is never trusted.
4. The shipment is found by the tracking's `custom_fields.swell_shipment_id` (when that shipment has this tracking ID), else
   by `$app.aftership.tracking_id`. Trackings that don't belong to a shipment in this store and environment are
   acknowledged and ignored.
5. Updates older than the one already saved (by the tracking's `updated_at`) are ignored, so webhooks arriving out of order
   don't overwrite newer status.

Network errors, HTTP 429 and 5xx from AfterShip, and errors saving the update in Swell, answer `503`, so AfterShip sends
the webhook again later. A tracking that no longer exists (AfterShip meta code `4004`) is acknowledged and ignored; other
AfterShip errors are logged and acknowledged.

### Hourly refresh

`functions/refresh-tracking.ts` runs every hour at minute 15, as a fallback for missed webhooks. It reloads up to 50
trackings, least recently checked first, that:

- belong to shipments created in the last 60 days that aren't canceled, and
- have one of the other statuses (Pending, Info received, In transit, Out for delivery, Delivery attempt failed, Ready
  for pickup, Exception). Shipments are matched by status rather than by tracking ID, because a `null` in a function's
  query isn't sent as null.

A run stops starting new shipments after 7 seconds, well within the default 10-second function timeout. Each checked shipment gets a new `checked_at`, so the next run starts with others. A tracking
deleted in AfterShip (meta code `4004`; a plain 404 isn't treated as deleted) is cleared from the shipment with the error "The tracking was deleted in AfterShip." and isn't refreshed or sent again unless
the tracking number changes. A rejected API key (401) or forbidden call (403) stops the run.

### The order's AfterShip tab

`content/orders.json` adds an **AfterShip** tab to orders with read-only fields (`models/orders.json`):

| Field | Value |
|---|---|
| Delivery status | the shipments' common status; else **Exception** or **Delivery attempt failed** if any shipment has it; else **Partly delivered (n of m)**; else the first status that isn't Pending |
| Estimated delivery | the latest estimate of the shipments not delivered yet, as a date (`YYYY-MM-DD`, the carrier's local date) |
| Delivered | the date the last shipment was delivered, once all are (`YYYY-MM-DD`, the carrier's local date) |
| Tracking page | AfterShip tracking page of the first shipment not delivered yet, else of the latest updated one |
| Shipments | one line per shipment with a tracking: number, courier and tracking number, status, latest scan and tracking page. A shipment AfterShip refused, or whose tracking was deleted in AfterShip, shows "Not tracked:" with the reason and its own tracking number; all values of the old tracking (number, courier, status, latest scan, tracking page, dates) are cleared from the shipment. |

Statuses are AfterShip's tags: Pending, Info received, In transit, Out for delivery, Delivery attempt failed, Ready for
pickup, Delivered, Exception, Expired. Canceled shipments, and shipments the app hasn't sent (no tracking number, a draft,
or sent before the app was installed), aren't listed.

### Send existing shipments

The **Send existing shipments** action starts the `functions/import-shipments.ts` workflow itself (`action: true`),
with the dialog's period in `req.data.days` and the environment in `req.environmentId`. The dashboard follows the run:
it shows it as running, doesn't start a second one while it runs, and says when it finished ("finished") or failed (a
red error popup with the run's error). The workflow builds the order links in AfterShip from the store's address, or
from the store id when a workflow gets only that (`https://<store>.swell.store/admin`, `/admin/test` in the test
environment); only the URL's path is changed, so a store id starting with "admin" keeps its host. In its dialog, choose
shipments created in the last **7**, **30** (default) or **90** days. The workflow pages through those shipments (50 per
step, by ID; canceled ones aren't loaded) and sends each one exactly as a shipment event would, 3 at a time.

Each run reports: sent, linked to existing trackings, already sent (including shipments AfterShip refused before, until their tracking number or carrier changes), skipped (draft, no tracking number or order not found) and failed
(AfterShip refused the shipment; the reason is saved on the shipment and listed on the order's AfterShip tab).

- A run where any shipment failed ends as failed, with the totals, so the dashboard shows it as a red error popup:
  "Import finished, but 2 shipments failed; the reasons are on each order's AfterShip tab. Totals: …", or "… AfterShip
  refused all 2 shipments it was sent …" when none was sent or linked. A run without failures shows the regular
  "finished" notice.
- It doesn't start when the app is off, **Send shipments to AfterShip** is off, or the API key is missing: the run fails
  right away ("Import not started: …"), which the dashboard shows as a red error popup.
- Settings are read again before each page. If the app or sending is turned off, or the key removed, during the run, it
  stops and fails with the totals so far.
- A rejected API key or forbidden call fails the run right away with the totals so far. Network errors, 429 and 5xx are
  retried up to 5 times, starting after 30 seconds with exponential backoff; shipments the page already sent are counted
  as already sent on the retry.
- Step output holds only counts and flags, never the API key or webhook secret.

### Test connection

The **Test connection** action lists the couriers turned on in AfterShip (`GET /couriers`), says whether a webhook secret
is set (it can't check that the secret is AfterShip's: only a signed webhook shows that), and notes when the app is turned off. It works while **Enabled** is off and sends no store data. AfterShip errors
are explained: a rejected key (401), a forbidden call (403: key permissions or plan), rate limits (429), and AfterShip
being unavailable. Only temporary errors say "try again". A missing API key, every AfterShip error and a failed Swell
settings read ("Test connection failed: …") show as a red error popup (a `SwellError` with status 400); the result is a regular message, including the note to add a webhook
secret.

### Retries and duplicates

- Shipment events rethrow AfterShip's network errors, 429 and 5xx, and failed Swell reads or writes (loading the
  shipment or order, saving the tracking), so Swell runs the event again. That's safe: a tracking that already exists
  is linked (`4003`), not created twice, and deleting a tracking that's gone succeeds.
- Errors about the shipment itself (for example an invalid tracking number) are saved on the shipment with the `synced`
  key, so it isn't sent again on every update; changing the tracking number or carrier sends it again.
- A rejected API key (401), a forbidden call (403) or a plain 404 (a wrong path or retired API version, not the
  shipment's fault) is logged and not saved, so the shipment is sent on its next tracking change or by **Send existing
  shipments** once the cause is fixed.

### Turning the app off

With **Enabled** off nothing is sent to AfterShip and nothing is saved from it:

- shipment events return before loading any record, so no trackings are created or deleted;
- the webhook still checks signatures, then acknowledges events without calling AfterShip;
- the hourly refresh does nothing;
- **Send existing shipments** doesn't start, and a running import stops before its next page.

**Test connection** still works, so you can check the API key before turning the app on.

## Settings

All credentials and options are set by the merchant in the app settings (`settings/aftership.json`) and are never stored
in code.

| Setting | Required | Default | Description |
|---|---|---|---|
| API key | yes | | AfterShip → Settings → API keys. Stored as a secret. A restricted key needs read and write access to trackings. |
| Enabled | no | on | Turns off everything the app sends to AfterShip and ignores incoming webhooks. |
| **Shipments** | | | |
| Send shipments to AfterShip | no | on | Creates a tracking when a shipment gets a tracking number, and a new one when the number changes. |
| Share customer contact | no | on | Sends the customer's name, email and phone, so AfterShip notifications can reach them. |
| Delete trackings of canceled shipments | no | on | Deletes the AfterShip tracking when the shipment is canceled or deleted. |
| Tags | no | | Optional. Comma-separated tags added to every tracking. Empty: no tags, and `shipment_tags` is left out. |
| **Tracking updates** | | | |
| Webhook secret | for the webhook | | AfterShip → Settings → Webhooks. Stored as a secret. Without it every webhook is rejected and status comes only from the hourly refresh. |
| Webhook URL | read-only | `https://{store-id}:{public-key}@{store-id}.swell.store/functions/aftership/aftership-webhook` | The URL pattern to add in AfterShip, with the placeholders replaced. |

**Actions** (Actions menu on the app's settings page): **Test connection** and **Send existing shipments** (shown while
**Send shipments to AfterShip** is on).

## Setup

1. In AfterShip, go to **Settings → API keys** and create an API key with the **API key** authentication type (AES and
   RSA signature keys aren't supported). AfterShip's API is part of its paid plans; check that yours includes it.
2. Install the app in Swell, open its settings, enter the **API key** and save. Run **Test connection**; it should say
   "Connected to AfterShip".
3. In AfterShip, go to **Settings → Webhooks** and copy the **webhook secret** into the app's **Webhook secret** setting.
   Save.
4. Build the webhook URL from the read-only **Webhook URL** setting:
   - `{store-id}`: your Swell store ID, the subdomain of your `*.swell.store` address;
   - `{public-key}`: a Swell **public** key from **Developer → API keys**. Use the test key for the test environment and
     the live key for live. Never use a secret key here.

   Add the URL in AfterShip → **Settings → Webhooks** and select tracking updates.
5. *(Optional)* In AfterShip, turn on the couriers you ship with (better courier detection) and set up customer
   notifications.
6. Create a shipment with a tracking number on a test order. Within a few seconds it appears in AfterShip, and the order's
   **AfterShip** tab shows its status.
7. *(Optional)* Run **Send existing shipments** to send shipments from the last 7, 30 or 90 days.

To check the webhook without waiting for a carrier scan, sign a body with your webhook secret and send it:

```bash
BODY='{"event":"tracking_update","msg":{"id":"{tracking-id}"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac '{webhook-secret}' -binary | base64)
curl -X POST 'https://{store-id}:{public-key}@{store-id}.swell.store/functions/aftership/aftership-webhook' \
  -H 'Content-Type: application/json' -H "aftership-hmac-sha256: $SIG" -d "$BODY"
```

With the ID of a tracking the app created it answers `{"received":true,"processed":true}` (or `processed: false` when the
shipment already has a newer update). Without a valid signature it answers `401`.

## Limits and known behavior

- **One tracking per shipment.** The shipment's `tracking_code` is used, or the first package number when it has none.
  Other package numbers aren't sent.
- **Test and live share one AfterShip account.** Webhooks for live trackings also reach the test webhook URL (and the
  other way round) if both are added; they're ignored because no shipment there has that tracking. When the same number
  is sent from both environments, both shipments link to the one AfterShip tracking.
- **Courier detection.** Carriers without a known AfterShip slug are left to AfterShip's detection, which works best with
  the couriers you use turned on in AfterShip. A wrong guess can be corrected in AfterShip.
- **Customer notifications come from AfterShip.** The app doesn't send emails; AfterShip does, if notifications are set
  up there and **Share customer contact** is on.
- **Only ids in custom fields.** AfterShip asks not to put personal data in `custom_fields`; the app sends only the Swell
  shipment and order IDs there.
- **Rate limit.** AfterShip allows 10 requests a second by default. A shipment event makes 1–4 calls (create; a second create
  without the courier when it's refused; a lookup on `4003`; a delete when the number changed). The import sends 3 shipments at a time, and the refresh checks one tracking
  at a time.
- **Refresh window.** The hourly refresh stops after 60 days or once a tracking is Delivered or Expired; webhooks still
  update the shipment after that.
- **Estimated delivery** is AfterShip's latest estimate, else its own prediction, else the carrier's. The shipment keeps
  it as AfterShip gives it (a date or date-time); the order's tab shows its date.
- **Shipment edits that don't change tracking** (notes, items) aren't sent; AfterShip keeps what it was sent first.

## Development

### Project layout

```
functions/
  shipment-sync.ts       # shipment.created/updated → tracking; canceled/deleted → delete tracking
  aftership-webhook.ts   # public route: signed AfterShip tracking webhooks
  refresh-tracking.ts    # cron, hourly: reload trackings still in transit
  test-connection.ts     # settings action: API key, couriers, webhook secret
  import-shipments.ts    # workflow started by the Send existing shipments action: last 7/30/90 days
  lib/aftership.ts       # settings, API client, tracking body and values, errors, webhook signatures
  lib/shipments.ts       # sending, linking, applying updates, order summary
  lib/modules.d.ts       # types for country-iso-2-to-3
models/shipments.json    # tracking on shipments ($app.aftership)
models/orders.json       # tracking summary on orders ($app.aftership)
content/orders.json      # AfterShip tab on orders
settings/aftership.json  # merchant settings and settings actions
assets/icon.png          # app icon (official AfterShip mark)
assets/screenshots/      # listing screenshots, referenced by `images` in swell.json
test/unit/               # vitest unit tests (AfterShip API mocked)
test/integration/        # vitest tests against the store using CLI auth
```

### Commands

```bash
npm run typecheck                 # TypeScript check for functions and tests
npm test                          # run all vitest tests
swell app dev                     # run functions locally, triggered by the test environment
swell app push                    # deploy to the test environment
swell inspect functions --app=.   # check deployed functions
swell logs --type function -s AfterShip   # function logs
swell inspect workflow-runs --workflow app.aftership.import-shipments   # import runs
```

Push with Swell CLI 2.9.30 or later: earlier versions don't give workflows `req.environmentId`, so an import started
in the test environment would link its trackings to the live dashboard.

Tests run in the Cloudflare Workers runtime via `@cloudflare/vitest-pool-workers` and use your `swell login` session (or
`SWELL_STORE_ID` / `SWELL_SESSION_ID` in CI). Unit tests mock `fetch` by AfterShip endpoint
(`test/helpers/aftership-fixtures.ts`), so no real AfterShip calls are made.

To try it end to end, use an AfterShip account with API access, set its API key and webhook secret in the test
environment, add the test webhook URL in AfterShip, and create a shipment with a real tracking number on a test order.

Workflows don't run under `swell app dev`; the action always starts the pushed version.
