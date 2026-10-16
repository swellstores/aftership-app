import { getSettings, missingSettings, swellEnv } from './lib/aftership';

export const config: SwellConfig = {
  description: 'Start sending existing shipments in the current environment',
  action: true,
};

// a thrown 400 shows in the admin as a red error popup, a returned message as a regular one
function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

// Workflows get no request headers, so this action reads the environment (Swell-Env) and passes it with the modal's
// period: order links in AfterShip then open the test or live dashboard like the ones sent for new shipments
export default async function (req: SwellRequest) {
  // checked here too, so the merchant sees why right away instead of in a failed run; the workflow checks again
  const settings = getSettings(await req.swell.settings());
  if (!settings.enabled) {
    fail('Import not started: the AfterShip app is turned off in its settings.');
  }
  if (!settings.sync_shipments) {
    fail('Import not started: Send shipments to AfterShip is off in the app settings.');
  }
  const missing = missingSettings(settings);
  if (missing.length) {
    fail(`Import not started: add the ${missing.join(', ')} in Apps → AfterShip.`);
  }

  let run: { id?: string } | undefined;
  try {
    run = await req.swell.workflows.create('import-shipments', { env: swellEnv(req), days: req.data?.days ?? null });
  } catch (err) {
    fail(`Import not started: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`AfterShip: started shipment import ${run?.id}${swellEnv(req) ? ' (test environment)' : ''}`);
  return { message: 'Import started. Follow it in the Workflows tab of the app.' };
}
