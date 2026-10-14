# AfterShip

Track every Swell shipment in AfterShip, and see its delivery status right on the order.

## How it works

1. **Shipments become AfterShip trackings.** When a shipment gets a tracking number, it's sent to AfterShip with the order number, destination and courier. Change the number and the tracking is replaced.
2. **Delivery status on the order.** Each order gets an AfterShip tab with the delivery status, estimated delivery, latest scan and tracking page of every shipment.
3. **Updates as the carrier scans.** AfterShip sends status changes to Swell through a signed webhook, and the app checks trackings still in transit every hour.
4. **Branded notifications.** Share the customer's name, email and phone with AfterShip, so its tracking emails and texts reach them.
5. **Canceled shipments cleaned up.** Canceling or deleting a shipment deletes its AfterShip tracking.
6. **Send recent shipments.** Send shipments from the last 7, 30 or 90 days in one click.

## Setup

Create an API key in AfterShip → Settings → API keys and copy the webhook secret from Settings → Webhooks. Enter both in the app settings and run **Test connection**, then add the webhook URL shown in the settings to AfterShip.
