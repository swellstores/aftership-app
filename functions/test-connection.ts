import { aftershipRequest, connectionError, getSettings, missingSettings } from './lib/aftership';

export const config: SwellConfig = {
  description: 'Check the AfterShip API key, and that a webhook secret is set',
  action: true,
};

// couriers listed by name in the message
const SHOWN_COURIERS = 5;

// a thrown 400 shows in the admin as a red error popup, a returned message as a regular one
function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

// works while the app is turned off, so the key can be checked before turning it on
export default async function (req: SwellRequest) {
  const settings = getSettings(await req.swell.settings());

  const missing = missingSettings(settings);
  if (missing.length) {
    fail(`Add the ${missing.join(', ')} and save the settings first.`);
  }

  let couriers: any[];
  try {
    // the couriers turned on in the AfterShip account
    couriers = (await aftershipRequest(settings, 'GET', '/couriers'))?.couriers || [];
  } catch (err) {
    fail(connectionError(err));
  }

  const names = couriers.map((c) => c?.name || c?.slug).filter(Boolean);
  const notes = [
    names.length
      ? `Connected to AfterShip. ${names.length} courier${names.length > 1 ? 's' : ''} turned on: ${names.slice(0, SHOWN_COURIERS).join(', ')}${names.length > SHOWN_COURIERS ? ', …' : ''}.`
      : 'Connected to AfterShip. No couriers are turned on in AfterShip yet, so it detects the courier from each tracking number.',
  ];
  notes.push(
    settings.webhook_secret
      ? 'Webhook secret is set.'
      : 'Add the webhook secret from AfterShip → Settings → Webhooks, or tracking updates arrive only with the hourly refresh.',
  );
  if (!settings.enabled) {
    notes.push('The app is turned off, so nothing is sent until you turn it on.');
  }
  return { message: notes.join(' ') };
}
