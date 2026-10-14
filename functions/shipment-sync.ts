import { APP_ID, AfterShipError, handleError, loadSettings } from './lib/aftership';
import { getShipment, isTrackingChange, removeShipment, syncShipment } from './lib/shipments';

export const config: SwellConfig = {
  description: 'Send shipments to AfterShip and delete trackings of canceled shipments',
  model: {
    events: ['shipment.created', 'shipment.updated', 'shipment.canceled', 'shipment.deleted'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const type: string | undefined = data.$event?.type;
  const appId = req.appId || APP_ID;

  const settings = await loadSettings(swell);
  if (!settings) {
    return;
  }

  if (type === 'shipment.canceled' || type === 'shipment.deleted') {
    if (!settings.delete_canceled) {
      return;
    }
    const deleted = type === 'shipment.deleted';
    try {
      // a deleted shipment can't be loaded any more, so its event data is used
      const shipment = deleted ? data : await getShipment(swell, data.id);
      if (!shipment) {
        return;
      }
      const trackingId = await removeShipment(swell, settings, shipment, { appId, deleted });
      if (trackingId) {
        console.log(`AfterShip: deleted tracking ${trackingId} of ${deleted ? 'deleted' : 'canceled'} shipment ${data.id}`);
      }
    } catch (err) {
      handleError(`deleting the tracking of shipment ${data.id}`, err);
      retryIfTemporary(err);
    }
    return;
  }

  if (!settings.sync_shipments || !isTrackingChange(type, data)) {
    return;
  }

  try {
    const shipment = await getShipment(swell, data.id);
    const result = await syncShipment(swell, settings, shipment, { appId, adminUrl: req.store?.admin_url });
    if (result.status === 'created' || result.status === 'linked') {
      console.log(`AfterShip: shipment ${data.id} ${result.status === 'created' ? 'sent as' : 'linked to'} tracking ${result.tracking_id}`);
    } else if (result.status === 'failed') {
      console.error(`AfterShip: shipment ${data.id} not sent: ${result.reason}`);
    }
  } catch (err) {
    handleError(`sending shipment ${data.id}`, err);
    retryIfTemporary(err);
  }
}

// network errors, 429 and 5xx are rethrown so Swell runs the event again; that's safe because a tracking
// that already exists is linked instead of created twice, and deleting one that's gone succeeds
function retryIfTemporary(err: unknown) {
  if (err instanceof AfterShipError && err.retryable) {
    throw err;
  }
}
