import { APP_ID, AfterShipError, adminUrlOf, handleError, loadSettings, swellEnv } from './lib/aftership';
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
    // shipment.deleted delivers only { $event }: the deleted shipment, with the app's values, is in $event.data
    const id = data?.id || data?.$event?.data?.id;
    try {
      const shipment = deleted ? deletedShipment(data) : await getShipment(swell, id);
      if (!shipment?.id) {
        console.log(`AfterShip: no shipment in the ${type} event, nothing to delete`);
        return;
      }
      const trackingId = await removeShipment(swell, settings, shipment, { appId, deleted });
      if (trackingId) {
        console.log(`AfterShip: deleted tracking ${trackingId} of ${deleted ? 'deleted' : 'canceled'} shipment ${id}`);
      }
    } catch (err) {
      handleError(`deleting the tracking of shipment ${id}`, err);
      retryIfTemporary(err);
    }
    return;
  }

  if (!settings.sync_shipments || !isTrackingChange(type, data)) {
    return;
  }

  try {
    const shipment = await getShipment(swell, data.id);
    const result = await syncShipment(swell, settings, shipment, { appId, adminUrl: adminUrlOf(req.store, swellEnv(req)) });
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

// the deleted shipment: the event's record (shipment.deleted), else the data itself
export function deletedShipment(data: any): any | null {
  const record = data?.$event?.data;
  if (record && typeof record === 'object' && record.id) return record;
  return data?.id ? data : null;
}

// AfterShip's network errors, 429 and 5xx, and failed Swell reads or writes (anything that isn't an AfterShipError)
// are rethrown so Swell runs the event again; that's safe because a tracking that already exists is linked instead of
// created twice, and deleting one that's gone succeeds. AfterShip's permanent errors (401, 403, 404) aren't retried.
function retryIfTemporary(err: unknown) {
  if (!(err instanceof AfterShipError) || err.retryable) {
    throw err;
  }
}
