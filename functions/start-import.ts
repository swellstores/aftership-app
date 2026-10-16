import { swellEnv } from './lib/aftership';

export const config: SwellConfig = {
  description: 'Start sending existing shipments in the current environment',
  action: true,
};

// Workflows get no request headers, so this action reads the environment (Swell-Env) and passes it with the modal's
// period: order links in AfterShip then open the test or live dashboard like the ones sent for new shipments
export default async function (req: SwellRequest) {
  const run = await req.swell.workflows.create('import-shipments', { env: swellEnv(req), days: req.data?.days ?? null });
  console.log(`AfterShip: started shipment import ${run?.id}${swellEnv(req) ? ' (test environment)' : ''}`);
  return { message: 'Import started. Follow it in the Workflows tab of the app.' };
}
