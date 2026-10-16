Track every Swell shipment in AfterShip, and see its delivery status on the order. Shipments with a tracking number become AfterShip trackings with the order number, destination and customer, and AfterShip's status comes back to the order's AfterShip tab.

Connect AfterShip with an API key and your webhook secret. AfterShip then tracks each parcel with the carrier and, if you've set them up in AfterShip, sends its own tracking notifications to your customers.

- **Shipments become trackings.** When a shipment gets a tracking number, it's sent to AfterShip with the order number, ship date, destination, courier and your tags. Change the number or carrier and the tracking is replaced.
- **Delivery status on the order.** Each order's AfterShip tab shows the delivery status, estimated delivery, delivery date and tracking page, with a line for every shipment and its latest scan.
- **Updates as the carrier scans.** AfterShip sends status changes to Swell through a signed webhook, and the app checks trackings still in transit every hour.
- **Notifications that reach your customers.** Share each customer's name, email and phone number with AfterShip, so its tracking notifications reach them.
- **Canceled shipments cleaned up.** Canceling or deleting a shipment in Swell deletes its AfterShip tracking.
- **Bring in recent shipments.** Send shipments from the last 7, 30 or 90 days from the Actions menu. The import runs in the background, and each run shows on the app's Workflows tab.

Setup takes a few minutes. In AfterShip, create an API key under Settings > API keys and copy the webhook secret from Settings > Webhooks. Enter both in the app settings, save, and choose Actions > Test connection. Then fill in your store ID and a Swell public key in the webhook URL shown in the settings, and add it in AfterShip under Settings > Webhooks.
