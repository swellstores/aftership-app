import {
  APP_ID,
  AfterShipError,
  NO_TRACKING,
  OPEN_STATUSES,
  appData,
  appValues,
  connectionError,
  createTracking,
  deleteTracking,
  findTracking,
  statusLabel,
  syncKey,
  trackingNumber,
  trackingValues,
  type AfterShipSettings,
  type SwellClient,
} from './aftership';

export interface SyncOptions {
  appId?: string;
  adminUrl?: string;
}

export type SyncStatus = 'created' | 'linked' | 'unchanged' | 'skipped' | 'failed';

export interface SyncResult {
  status: SyncStatus;
  reason?: string;
  tracking_id?: string;
}

// shipment fields that decide what is sent to AfterShip; other updates (including the app's own) are ignored
const TRACKING_FIELDS = ['tracking_code', 'carrier', 'carrier_name', 'packages', 'canceled', 'draft'];

// true when a shipment event may change its tracking. Functions get the whole shipment; the fields the update
// changed are in $event.data
export function isTrackingChange(eventType: string | undefined, data: any): boolean {
  if (eventType !== 'shipment.updated') {
    return true;
  }
  const changed = data?.$event?.data;
  if (!changed || typeof changed !== 'object') {
    return true;
  }
  return TRACKING_FIELDS.some((field) => changed[field] !== undefined);
}

export async function getShipment(swell: Pick<SwellClient, 'get'>, id: string): Promise<any> {
  return swell.get('/shipments/{id}', { id });
}

async function getOrder(swell: Pick<SwellClient, 'get'>, id: string): Promise<any> {
  return swell.get('/orders/{id}', {
    id,
    expand: ['account'],
    fields: 'id,number,date_created,account_id,account,billing,shipping',
  });
}

// errors about the shipment itself (e.g. an invalid tracking number); credential and temporary errors aren't
export function isShipmentError(err: unknown): err is AfterShipError {
  return err instanceof AfterShipError && !err.retryable && err.status !== 401 && err.status !== 403;
}

// send a shipment to AfterShip unless its current tracking number was already sent.
// Throws on credential and temporary errors so the caller can stop or retry; errors about the shipment are saved on it.
export async function syncShipment(
  swell: SwellClient,
  settings: AfterShipSettings,
  shipment: any,
  { appId = APP_ID, adminUrl }: SyncOptions = {},
): Promise<SyncResult> {
  if (!shipment?.id) return { status: 'skipped', reason: 'shipment not found' };
  if (shipment.canceled) return { status: 'skipped', reason: 'shipment canceled' };
  if (shipment.draft) return { status: 'skipped', reason: 'shipment is a draft' };

  const key = syncKey(shipment);
  if (!key) return { status: 'skipped', reason: 'no tracking number' };

  const current = appData(shipment, appId);
  if (current.synced === key) return { status: 'unchanged' };

  const order = await getOrder(swell, shipment.order_id);
  if (!order) return { status: 'skipped', reason: `order ${shipment.order_id} not found` };

  try {
    const { tracking, existing } = await createTracking(settings, shipment, order, { adminUrl });

    // the tracking number or carrier changed: the old tracking follows a parcel that isn't this shipment's
    if (current.tracking_id && current.tracking_id !== tracking.id) {
      await deleteTracking(settings, current.tracking_id).catch((err) =>
        console.error(`AfterShip: couldn't delete old tracking ${current.tracking_id}: ${err?.message || err}`),
      );
    }

    await swell.put(`/shipments/${shipment.id}`, appValues({ ...trackingValues(tracking), synced: key }, appId));
    await updateOrderSummary(swell, shipment.order_id, appId);
    return { status: existing ? 'linked' : 'created', tracking_id: tracking.id };
  } catch (err) {
    if (!isShipmentError(err)) throw err;
    // the old tracking is for the previous number or carrier, so it's deleted even though the new one was refused
    if (current.tracking_id) {
      await deleteTracking(settings, current.tracking_id).catch((deleteErr) =>
        console.error(`AfterShip: couldn't delete old tracking ${current.tracking_id}: ${deleteErr?.message || deleteErr}`),
      );
    }
    // saved with the key so it isn't sent again until the tracking number or carrier changes
    await swell.put(
      `/shipments/${shipment.id}`,
      appValues(
        {
          ...NO_TRACKING,
          synced: key,
          error: connectionError(err),
        },
        appId,
      ),
    );
    await updateOrderSummary(swell, shipment.order_id, appId);
    return { status: 'failed', reason: err.detail };
  }
}

// the shipment an AfterShip tracking belongs to, or null when it isn't one the app created in this store
export async function findShipment(swell: Pick<SwellClient, 'get'>, tracking: any, appId = APP_ID): Promise<any | null> {
  const id = tracking?.custom_fields?.swell_shipment_id;
  if (typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id)) {
    const shipment = await getShipment(swell, id);
    if (shipment && appData(shipment, appId).tracking_id === tracking.id) {
      return shipment;
    }
  }
  // the same number sent from another store or environment links to one tracking, so look it up by id too
  const found = await swell.get('/shipments', { where: { [`$app.${appId}.tracking_id`]: tracking.id }, limit: 1 });
  return found?.results?.[0] || null;
}

// save the tracking's status on the shipment and order; false when an older update arrives after a newer one
export async function applyTracking(swell: SwellClient, shipment: any, tracking: any, appId = APP_ID): Promise<boolean> {
  const current = appData(shipment, appId);
  if (tracking.updated_at && current.updated_at && Date.parse(tracking.updated_at) < Date.parse(current.updated_at)) {
    return false;
  }
  await swell.put(`/shipments/${shipment.id}`, appValues(trackingValues(tracking), appId));
  await updateOrderSummary(swell, shipment.order_id, appId);
  return true;
}

// clear the tracking from a shipment (canceled, deleted in AfterShip); a later number change sends it again
export async function clearTracking(swell: SwellClient, shipment: any, values: Record<string, any>, appId = APP_ID) {
  await swell.put(
    `/shipments/${shipment.id}`,
    appValues({ ...NO_TRACKING, ...values }, appId),
  );
  await updateOrderSummary(swell, shipment.order_id, appId);
}

// delete the AfterShip tracking of a canceled or deleted shipment
export async function removeShipment(
  swell: SwellClient,
  settings: AfterShipSettings,
  shipment: any,
  { appId = APP_ID, deleted = false }: { appId?: string; deleted?: boolean } = {},
): Promise<string | null> {
  let trackingId = appData(shipment, appId).tracking_id;

  // a deleted shipment may arrive without the app's values: find its tracking by number and Swell shipment id
  if (!trackingId && deleted) {
    const number = trackingNumber(shipment);
    const tracking = number ? await findTracking(settings, number) : null;
    if (tracking?.custom_fields?.swell_shipment_id === shipment.id) {
      trackingId = tracking.id;
    }
  }
  if (!trackingId) return null;

  await deleteTracking(settings, trackingId);
  if (deleted) {
    if (shipment.order_id) await updateOrderSummary(swell, shipment.order_id, appId);
  } else {
    // synced is cleared so the shipment is sent again if it's un-canceled
    await clearTracking(swell, shipment, { synced: null, error: null }, appId);
  }
  return trackingId;
}

const DAY = 24 * 60 * 60 * 1000;

// trackings are refreshed for this long after the shipment was created
export const MAX_TRACKING_AGE_DAYS = 60;

// shipments with a tracking that can still change, least recently checked first
export async function getTrackingShipments(swell: Pick<SwellClient, 'get'>, limit: number, appId = APP_ID): Promise<any[]> {
  const prefix = `$app.${appId}`;
  const result = await swell.get('/shipments', {
    // matched by status only: null in a query isn't sent as null, so { $ne: null } would match every shipment
    where: {
      [`${prefix}.status`]: { $in: OPEN_STATUSES },
      canceled: { $ne: true },
      date_created: { $gte: new Date(Date.now() - MAX_TRACKING_AGE_DAYS * DAY).toISOString() },
    },
    sort: `${prefix}.checked_at asc`,
    limit,
  });
  return (result?.results || []).filter((shipment: any) => appData(shipment, appId).tracking_id);
}

// one line per shipment for the order's AfterShip tab
function summaryLine(shipment: any, values: Record<string, any>): string {
  const parts = [
    shipment.number ? `Shipment ${shipment.number}` : 'Shipment',
    // a shipment without a tracking shows its own tracking number, not one from a cleared tracking
    [values.courier?.toUpperCase(), values.tracking_number || trackingNumber(shipment)].filter(Boolean).join(' '),
    values.error && !values.tracking_id ? `Not tracked: ${values.error}` : statusLabel(values.status),
    values.last_event,
    values.tracking_url,
  ];
  return parts.filter(Boolean).join(' · ');
}

// overall status of the order's trackings
export function orderStatus(statuses: string[]): string | null {
  if (!statuses.length) return null;
  if (statuses.every((s) => s === statuses[0])) return statusLabel(statuses[0]);
  for (const attention of ['Exception', 'AttemptFail']) {
    if (statuses.includes(attention)) return statusLabel(attention);
  }
  const delivered = statuses.filter((s) => s === 'Delivered').length;
  if (delivered) return `Partly delivered (${delivered} of ${statuses.length})`;
  return statusLabel(statuses.find((s) => s !== 'Pending') || statuses[0]);
}

const latest = (dates: (string | null | undefined)[]) =>
  dates.filter(Boolean).sort((a, b) => Date.parse(b!) - Date.parse(a!))[0] || null;

// the order's AfterShip tab: overall status and one line per shipment
export async function updateOrderSummary(swell: SwellClient, orderId: string, appId = APP_ID) {
  if (!orderId) return;
  const result = await swell.get('/shipments', { where: { order_id: orderId }, sort: 'date_created asc', limit: 100 });
  const shipments: any[] = (result?.results || []).filter((s: any) => !s.canceled);
  const entries = shipments
    .map((shipment) => ({ shipment, values: appData(shipment, appId) }))
    .filter(({ values }) => values.tracking_id || values.error);
  const tracked = entries.filter(({ values }) => values.tracking_id);
  const statuses = tracked.map(({ values }) => values.status || 'Pending');
  const allDelivered = statuses.length > 0 && statuses.every((s) => s === 'Delivered');
  const open = tracked.filter(({ values }) => values.status !== 'Delivered');
  const newest = [...tracked].sort((a, b) => Date.parse(b.values.updated_at || 0) - Date.parse(a.values.updated_at || 0))[0];

  await swell.put(
    `/orders/${orderId}`,
    appValues(
      {
        aftership_status: orderStatus(statuses),
        aftership_tracking_url: (open[0] || newest)?.values.tracking_url || null,
        aftership_estimated_delivery: allDelivered ? null : latest(open.map(({ values }) => values.estimated_delivery)),
        aftership_delivered_at: allDelivered ? latest(tracked.map(({ values }) => values.delivered_at)) : null,
        aftership_shipments: entries.map(({ shipment, values }) => summaryLine(shipment, values)).join('\n') || null,
      },
      appId,
    ),
  );
}
