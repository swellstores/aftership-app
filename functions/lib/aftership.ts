import getCountryISO3 from 'country-iso-2-to-3';
import { parsePhoneNumberWithError, type CountryCode } from 'libphonenumber-js';

export const APP_ID = 'aftership';

// AfterShip Tracking API version used for every call
export const API_VERSION = '2026-07';
export const API_BASE = `https://api.aftership.com/tracking/${API_VERSION}`;

// the parts of the Swell client the app uses; functions and workflows both provide them
export interface SwellClient {
  get(path: string, data?: any): Promise<any>;
  put(path: string, data?: any): Promise<any>;
  settings(): Promise<any>;
}

// values stored on a standard record under $app.<app id>
export function appValues(values: Record<string, any>, appId = APP_ID): { $app: Record<string, any> } {
  return { $app: { [appId]: values } };
}

// the app's values on a record
export function appData(record: any, appId = APP_ID): Record<string, any> {
  return record?.$app?.[appId] || {};
}

export interface AfterShipSettings {
  api_key: string;
  webhook_secret: string;
  enabled: boolean;
  sync_shipments: boolean;
  share_customer: boolean;
  delete_canceled: boolean;
  shipment_tags: string[];
}

// Error returned by the AfterShip API (or a network failure when status is 0)
export class AfterShipError extends Error {
  status: number;
  // AfterShip meta code, e.g. 4003 (tracking already exists) or 4010 (invalid courier slug)
  code: number | undefined;
  // the call AfterShip refused, e.g. "POST /trackings" (no query string)
  endpoint: string | undefined;

  constructor(status: number, code: number | undefined, message: string, endpoint?: string) {
    super(`AfterShip ${status}${code && code !== status ? ` (${code})` : ''}: ${message}`);
    this.name = 'AfterShipError';
    this.status = status;
    this.code = code;
    this.endpoint = endpoint;
  }

  // message with the refused call, for logs and workflow errors
  get detail(): string {
    return this.endpoint ? `${this.message} (${this.endpoint})` : this.message;
  }

  // network errors, rate limits and server errors are worth retrying
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

// AfterShip meta codes the app handles
export const TRACKING_EXISTS = 4003;
export const TRACKING_NOT_FOUND = 4004;
export const SLUG_INVALID = 4010;
export const BAD_COURIER = 4012;

// comma-separated tags → unique, trimmed tags
export function parseTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(list.map((tag) => String(tag).trim()).filter(Boolean))];
}

// read app settings and apply defaults for values the merchant has not saved yet
export function getSettings(all: any): AfterShipSettings {
  const raw = all?.aftership || {};
  const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

  return {
    api_key: text(raw.api_key),
    webhook_secret: text(raw.webhook_secret),
    enabled: flag(raw.enabled, true),
    sync_shipments: flag(raw.sync_shipments, true),
    share_customer: flag(raw.share_customer, true),
    delete_canceled: flag(raw.delete_canceled, true),
    // optional in AfterShip: no tags unless the merchant enters some
    shipment_tags: parseTags(raw.shipment_tags),
  };
}

// the settings the app needs before it can call AfterShip
export function missingSettings(settings: AfterShipSettings): string[] {
  return settings.api_key ? [] : ['API key'];
}

// load settings and check the app can call AfterShip; null when it's turned off or not set up
export async function loadSettings(swell: Pick<SwellClient, 'settings'>): Promise<AfterShipSettings | null> {
  const settings = getSettings(await swell.settings());
  if (!settings.enabled) {
    return null;
  }
  const missing = missingSettings(settings);
  if (missing.length) {
    console.error(`AfterShip: missing ${missing.join(', ')} in app settings`);
    return null;
  }
  return settings;
}

// call AfterShip; returns the response's data object (or null for empty responses)
export async function aftershipRequest(
  settings: Pick<AfterShipSettings, 'api_key'>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: object,
): Promise<any> {
  const endpoint = `${method} ${path.split('?')[0]}`;
  const headers: Record<string, string> = { accept: 'application/json', 'as-api-key': settings.api_key };
  if (body) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err: any) {
    throw new AfterShipError(0, undefined, err?.message || String(err), endpoint);
  }

  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const meta = json?.meta || {};
    const code = Number(meta.code);
    throw new AfterShipError(res.status, Number.isFinite(code) ? code : undefined, meta.message || text || res.statusText, endpoint);
  }
  return json?.data ?? null;
}

// AfterShip delivery statuses (the tracking's "tag") with the names shown in Swell
export const STATUS_LABELS: Record<string, string> = {
  Pending: 'Pending',
  InfoReceived: 'Info received',
  InTransit: 'In transit',
  OutForDelivery: 'Out for delivery',
  AttemptFail: 'Delivery attempt failed',
  AvailableForPickup: 'Ready for pickup',
  Delivered: 'Delivered',
  Exception: 'Exception',
  Expired: 'Expired',
};

// statuses that won't change any more; trackings in them aren't refreshed
export const FINAL_STATUSES = ['Delivered', 'Expired'];
export const OPEN_STATUSES = Object.keys(STATUS_LABELS).filter((tag) => !FINAL_STATUSES.includes(tag));

export function statusLabel(tag: string | null | undefined): string {
  return (tag && STATUS_LABELS[tag]) || tag || 'Pending';
}

// Swell carrier ids and names whose AfterShip courier slug differs from the lowercased name
const CARRIER_SLUGS: Record<string, string> = {
  dhl_express: 'dhl',
  dhlexpress: 'dhl',
  dhl_ecommerce: 'dhl-global-mail',
  canada_post: 'canada-post',
  canadapost: 'canada-post',
  royal_mail: 'royal-mail',
  royalmail: 'royal-mail',
  australia_post: 'australia-post',
  australiapost: 'australia-post',
  deutsche_post: 'deutsch-post',
  swiss_post: 'swiss-post',
  japan_post: 'japan-post',
  dpd_uk: 'dpd-uk',
  chronopost: 'chronopost-france',
};

// AfterShip courier slug for the shipment's carrier; undefined lets AfterShip detect the courier
export function carrierSlug(shipment: any): string | undefined {
  for (const value of [shipment?.carrier, shipment?.carrier_name]) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (CARRIER_SLUGS[key]) return CARRIER_SLUGS[key];
    // ids of app carriers (e.g. app_<id>_shippo) and custom services aren't couriers
    if (key.startsWith('app_')) continue;
    if (/^[a-z0-9_]+$/.test(key)) return key.replace(/_/g, '-');
  }
  return undefined;
}

// the shipment's tracking number: the shipment's own, else its first package's
export function trackingNumber(shipment: any): string {
  const codes = [shipment?.tracking_code, ...(shipment?.packages || []).map((p: any) => p?.tracking_code)];
  const code = codes.find((value) => typeof value === 'string' && value.trim());
  return code ? code.trim() : '';
}

// identifies what was sent for a shipment; a different key means the tracking number or carrier changed
export function syncKey(shipment: any): string {
  const number = trackingNumber(shipment);
  return number ? `${carrierSlug(shipment) || 'auto'}:${number}` : '';
}

// E.164 phone, or undefined when it can't be formatted (AfterShip SMS needs E.164)
export function formatPhone(phone: string | null | undefined, countryCode?: string): string | undefined {
  if (!phone) {
    return undefined;
  }
  try {
    const parsed = parsePhoneNumberWithError(phone, countryCode?.toUpperCase() as CountryCode);
    return parsed?.isValid() ? parsed.number : undefined;
  } catch {
    return undefined;
  }
}

// customer name: account name, first + last name, then the shipping name
export function customerName(order: any): string {
  const account = order?.account || {};
  const parts = [account.first_name, account.last_name].filter(Boolean).join(' ');
  return String(account.name || parts || order?.shipping?.name || '').trim();
}

// AfterShip accepts YYYY-MM-DDTHH:mm:ssZ dates, without milliseconds
export function aftershipDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// "test" when a function runs in the test environment (its Swell-Env header is exactly "test"), otherwise null
export function swellEnv(req: { headers?: Headers }): 'test' | null {
  return req.headers?.get('swell-env') === 'test' ? 'test' : null;
}

// the store's dashboard address. Functions get the store's address as admin_url (without /admin) and workflows only the
// store id, so it's built from either; test records are under /admin/test
export function adminUrlOf(store?: { id?: string; admin_url?: string } | null, env?: string | null): string {
  let url = (store?.admin_url || (store?.id ? `https://${store.id}.swell.store` : '')).replace(/\/+$/, '');
  if (!url) return '';
  if (env && url.includes(`/admin/${env}`)) url = url.replace(`/admin/${env}`, '/admin');
  if (!url.includes('/admin')) url = `${url}/admin`;
  if (env) url = url.replace('/admin', `/admin/${env}`);
  return url;
}

export function orderUrl(adminUrl: string | undefined, orderId: string): string | undefined {
  return adminUrl ? `${adminUrl.replace(/\/+$/, '')}/orders/${orderId}` : undefined;
}

export interface TrackingOptions {
  adminUrl?: string;
  // try the request without a courier slug, letting AfterShip detect the courier
  autoDetect?: boolean;
}

// AfterShip tracking for a Swell shipment and its order
export function buildTracking(shipment: any, order: any, settings: AfterShipSettings, options: TrackingOptions = {}) {
  const destination = shipment?.destination || order?.shipping || {};
  const country = typeof destination.country === 'string' ? destination.country.toUpperCase() : '';
  const slug = options.autoDetect ? undefined : carrierSlug(shipment);
  const email = order?.account?.email || order?.billing?.email;
  const phone = formatPhone(destination.phone || order?.shipping?.phone || order?.account?.phone, country);
  const name = customerName(order);

  const tracking: Record<string, any> = {
    tracking_number: trackingNumber(shipment),
    slug,
    title: order?.number ? `Order #${order.number}` : undefined,
    order_id: order?.id,
    order_number: order?.number ? String(order.number) : undefined,
    order_date: aftershipDate(order?.date_created),
    order_id_path: orderUrl(options.adminUrl, order?.id),
    tracking_ship_date: aftershipDate(shipment?.date_created),
    destination_country_region: country ? getCountryISO3(country) : undefined,
    destination_state: destination.state || undefined,
    destination_city: destination.city || undefined,
    destination_postal_code: destination.zip || undefined,
    shipment_tags: settings.shipment_tags.length ? settings.shipment_tags : undefined,
    // used to find the Swell shipment again when AfterShip sends an update
    custom_fields: { swell_shipment_id: shipment?.id, swell_order_id: order?.id },
  };

  if (settings.share_customer && (email || phone)) {
    tracking.customers = [
      Object.fromEntries(
        Object.entries({ name: name || undefined, email: email || undefined, phone_number: phone }).filter(
          ([, value]) => value !== undefined,
        ),
      ),
    ];
  }

  return Object.fromEntries(Object.entries(tracking).filter(([, value]) => value !== undefined && value !== ''));
}

export async function getTracking(settings: Pick<AfterShipSettings, 'api_key'>, id: string): Promise<any> {
  return aftershipRequest(settings, 'GET', `/trackings/${encodeURIComponent(id)}`);
}

// the existing tracking with this number (and courier, when known)
export async function findTracking(
  settings: Pick<AfterShipSettings, 'api_key'>,
  number: string,
  slug?: string,
): Promise<any | null> {
  const query = new URLSearchParams({ tracking_numbers: number, ...(slug ? { slug } : {}) });
  const data = await aftershipRequest(settings, 'GET', `/trackings?${query}`);
  const trackings: any[] = data?.trackings || [];
  return trackings.find((t) => t?.tracking_number === number && (!slug || t?.slug === slug)) || trackings[0] || null;
}

// create the tracking; an existing tracking for the same number is reused, and an unknown courier falls back to detection
export async function createTracking(
  settings: AfterShipSettings,
  shipment: any,
  order: any,
  options: TrackingOptions = {},
): Promise<{ tracking: any; existing: boolean }> {
  const body = buildTracking(shipment, order, settings, options);
  try {
    return { tracking: await aftershipRequest(settings, 'POST', '/trackings', body), existing: false };
  } catch (err) {
    if (!(err instanceof AfterShipError)) throw err;
    if (err.code === TRACKING_EXISTS) {
      // a retried event, an import, or the same number added in AfterShip directly
      const tracking = await findTracking(settings, body.tracking_number, body.slug);
      if (tracking) return { tracking, existing: true };
    }
    if ((err.code === SLUG_INVALID || err.code === BAD_COURIER) && body.slug && !options.autoDetect) {
      console.log(`AfterShip: courier ${body.slug} refused for ${body.tracking_number}, letting AfterShip detect it`);
      return createTracking(settings, shipment, order, { ...options, autoDetect: true });
    }
    throw err;
  }
}

// delete the tracking; one already gone counts as deleted
export async function deleteTracking(settings: Pick<AfterShipSettings, 'api_key'>, id: string): Promise<void> {
  try {
    await aftershipRequest(settings, 'DELETE', `/trackings/${encodeURIComponent(id)}`);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

// only AfterShip's "tracking does not exist" (meta code 4004): a plain 404, e.g. from a retired API version, would
// otherwise clear every tracking
export function isNotFound(err: unknown): boolean {
  return err instanceof AfterShipError && err.code === TRACKING_NOT_FOUND;
}

// best estimate of the delivery date AfterShip has
export function estimatedDelivery(tracking: any): string | null {
  return (
    tracking?.latest_estimated_delivery?.datetime ||
    tracking?.aftership_estimated_delivery_date?.estimated_delivery_date ||
    tracking?.courier_estimated_delivery_date?.estimated_delivery_date ||
    null
  );
}

// newest checkpoint (AfterShip lists them oldest first)
export function latestCheckpoint(tracking: any): any | null {
  const checkpoints: any[] = tracking?.checkpoints || [];
  return checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
}

// the values stored on the Swell shipment for an AfterShip tracking
// the tracking values a shipment loses when its tracking is cleared or refused, so the order shows nothing stale
export const NO_TRACKING = {
  tracking_id: null,
  tracking_number: null,
  courier: null,
  status: null,
  status_detail: null,
  last_event: null,
  last_event_at: null,
  estimated_delivery: null,
  delivered_at: null,
  tracking_url: null,
  updated_at: null,
};

export function trackingValues(tracking: any) {
  const checkpoint = latestCheckpoint(tracking);
  const location = checkpoint
    ? checkpoint.location || [checkpoint.city, checkpoint.state, checkpoint.country_region].filter(Boolean).join(', ')
    : '';
  return {
    tracking_id: tracking.id,
    tracking_number: tracking.tracking_number || null,
    courier: tracking.slug || null,
    status: tracking.tag || 'Pending',
    status_detail: tracking.subtag_message || null,
    last_event: checkpoint ? [checkpoint.message, location].filter(Boolean).join(' · ') || null : null,
    last_event_at: checkpoint?.checkpoint_time || null,
    estimated_delivery: estimatedDelivery(tracking),
    delivered_at: tracking.tag === 'Delivered' ? tracking.shipment_delivery_date || checkpoint?.checkpoint_time || null : null,
    tracking_url: tracking.aftership_tracking_url || tracking.courier_tracking_link || null,
    updated_at: tracking.updated_at || null,
    checked_at: new Date().toISOString(),
    error: null,
  };
}

// AfterShip's error as a message for the merchant, with what to do about it
export function connectionError(err: unknown): string {
  if (!(err instanceof AfterShipError)) {
    return `Unexpected error: ${(err as any)?.message || err}`;
  }
  if (err.status === 0) {
    return `Couldn't reach AfterShip (${err.message.replace(/^AfterShip 0: /, '')}). Try again later.`;
  }
  if (err.status === 401) {
    return 'AfterShip rejected the API key (401 Unauthorized). Check the API key in the app settings: copy it again from AfterShip → Settings → API keys, and use a key with the "API key" authentication type (AES and RSA signature keys aren\'t supported).';
  }
  if (err.status === 403) {
    return `AfterShip refused ${err.endpoint || 'the request'} (403 Forbidden). Check that the API key is allowed to read and write trackings, and that your AfterShip plan includes API access.`;
  }
  if (err.status === 429) {
    return 'AfterShip rate limit reached (429). Try again in a minute.';
  }
  if (err.retryable) {
    return `AfterShip is unavailable (${err.status}). Try again later.`;
  }
  return `AfterShip refused ${err.endpoint || 'the request'}: ${err.message.replace(/^AfterShip [^:]+: /, '')}`;
}

// log an error from an event or webhook; nothing is retried by throwing
export function handleError(action: string, err: unknown) {
  if (err instanceof AfterShipError) {
    console.error(`AfterShip: ${action} failed: ${err.detail}`);
  } else {
    console.error(`AfterShip: ${action} failed: ${(err as any)?.message || err}`);
  }
}

const encoder = new TextEncoder();

// base64 HMAC-SHA256 of the raw body, the way AfterShip signs webhooks (aftership-hmac-sha256 header)
export async function computeSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function verifySignature(secret: string, body: string, header?: string | null): Promise<boolean> {
  if (!secret || !header) {
    return false;
  }
  return safeEqual(header.trim(), await computeSignature(secret, body));
}

// constant-time string comparison
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
