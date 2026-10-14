import { APP_ID, AfterShipError, appValues, getTracking, handleError, isNotFound, loadSettings } from './lib/aftership';
import { applyTracking, clearTracking, getTrackingShipments } from './lib/shipments';

export const config: SwellConfig = {
  description: 'Refresh AfterShip tracking for shipments in transit',
  cron: {
    schedule: '15 * * * *',
  },
};

// shipments checked per run, and the time a run may take
export const BATCH_SIZE = 50;
export const BUDGET_MS = 20_000;

export interface RefreshSummary {
  checked: number;
  updated: number;
  errors: number;
}

// a fallback for missed webhooks: reloads trackings that can still change
export default async function (req: SwellRequest): Promise<RefreshSummary | undefined> {
  const { swell } = req;
  const settings = await loadSettings(swell);
  if (!settings) {
    return;
  }

  const appId = req.appId || APP_ID;
  const started = Date.now();
  const summary: RefreshSummary = { checked: 0, updated: 0, errors: 0 };

  for (const shipment of await getTrackingShipments(swell, BATCH_SIZE, appId)) {
    if (Date.now() - started > BUDGET_MS) {
      break;
    }
    const trackingId = shipment.$app?.[appId]?.tracking_id;
    summary.checked++;
    try {
      const tracking = await getTracking(settings, trackingId);
      if (await applyTracking(swell, shipment, tracking, appId)) {
        summary.updated++;
      } else {
        await swell.put(`/shipments/${shipment.id}`, appValues({ checked_at: new Date().toISOString() }, appId));
      }
    } catch (err) {
      if (isNotFound(err)) {
        // deleted in AfterShip: no longer refreshed, and not sent again unless the tracking number changes
        await clearTracking(swell, shipment, { error: 'The tracking was deleted in AfterShip.' }, appId);
        continue;
      }
      summary.errors++;
      handleError(`refreshing shipment ${shipment.id}`, err);
      // every other shipment would fail the same way
      if (err instanceof AfterShipError && (err.status === 401 || err.status === 403)) {
        break;
      }
      await swell.put(`/shipments/${shipment.id}`, appValues({ checked_at: new Date().toISOString() }, appId));
    }
  }

  if (summary.checked) {
    console.log('AfterShip: tracking refresh', summary);
  }
  return summary;
}
