import { APP_ID, connectionError, getSettings, getTracking, isNotFound, verifySignature } from './lib/aftership';
import { applyTracking, findShipment } from './lib/shipments';

export const config: SwellConfig = {
  description: 'Receive AfterShip tracking webhooks',
  route: {
    methods: ['post'],
    public: true,
  },
};

// AfterShip signs every webhook with the account's webhook secret (aftership-hmac-sha256, base64 HMAC-SHA256
// of the raw body). Requests without a valid signature are rejected. The tracking is then loaded again from the
// AfterShip API with the API key, so the payload itself is never trusted.
export async function post(req: SwellRequest) {
  const { swell } = req;
  const settings = getSettings(await swell.settings());

  // the exact text AfterShip sent; re-stringifying req.body would not match the signature
  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : typeof req.body === 'string' ? req.body : '';
  const signature = req.headers?.get('aftership-hmac-sha256');

  if (!settings.webhook_secret) {
    console.warn('AfterShip: webhook rejected, add the webhook secret in the app settings');
    throw new SwellError('Webhook secret is not set in the app settings', { status: 401 });
  }
  if (!(await verifySignature(settings.webhook_secret, rawBody, signature))) {
    console.warn('AfterShip: webhook rejected', { has_signature: Boolean(signature), body_length: rawBody.length });
    throw new SwellError('Invalid webhook signature', { status: 401 });
  }

  // acknowledged so AfterShip doesn't retry, but nothing is called or saved
  if (!settings.enabled || !settings.api_key) {
    return { received: true, processed: false };
  }

  const event = (typeof req.body === 'object' && req.body ? req.body : safeParse(rawBody)) as { event?: string; msg?: any };
  const trackingId = event?.msg?.id;
  if (typeof trackingId !== 'string' || !trackingId) {
    return { received: true, processed: false };
  }

  const appId = req.appId || APP_ID;
  try {
    const tracking = await getTracking(settings, trackingId);
    const shipment = tracking && (await findShipment(swell, tracking, appId));
    if (!shipment) {
      // a tracking created outside this store, or by the other environment (test or live)
      return { received: true, processed: false };
    }
    const applied = await applyTracking(swell, shipment, tracking, appId);
    if (applied) {
      console.log(`AfterShip: shipment ${shipment.id} is ${tracking.tag}`);
    }
    return { received: true, processed: applied };
  } catch (err: any) {
    if (isNotFound(err)) {
      return { received: true, processed: false };
    }
    console.error(`AfterShip: webhook for tracking ${trackingId} failed: ${err?.detail || err?.message || err}`);
    // temporary errors answer 5xx so AfterShip sends the webhook again later
    if (err?.retryable) {
      throw new SwellError(connectionError(err), { status: 503 });
    }
    return { received: true, processed: false };
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
