import { APP_ID, AfterShipError, connectionError, getSettings, missingSettings, type SwellClient } from './lib/aftership';
import { syncShipment, type SyncStatus } from './lib/shipments';

export const config: SwellConfig = {
  kind: 'workflow',
  description: 'Send existing shipments to AfterShip',
  action: true,
};

export const PAGE_SIZE = 50;
// shipments sent at the same time; AfterShip allows 10 requests a second
export const CONCURRENCY = 3;
export const DAY_OPTIONS = [7, 30, 90];
const DEFAULT_DAYS = 30;

const RETRIES = { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' as const } };

export interface ImportStats {
  created: number;
  linked: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export function emptyStats(): ImportStats {
  return { created: 0, linked: 0, unchanged: 0, skipped: 0, failed: 0 };
}

export function addStats(a: ImportStats, b: Partial<ImportStats>): ImportStats {
  return {
    created: a.created + (b.created || 0),
    linked: a.linked + (b.linked || 0),
    unchanged: a.unchanged + (b.unchanged || 0),
    skipped: a.skipped + (b.skipped || 0),
    failed: a.failed + (b.failed || 0),
  };
}

export const totalsText = (t: ImportStats) =>
  `sent ${t.created}, linked to existing trackings ${t.linked}, already sent ${t.unchanged}, skipped ${t.skipped}, failed ${t.failed}`;

// the modal's period in days; anything else falls back to 30
export function parseDays(value: unknown): number {
  const days = Number(value);
  return DAY_OPTIONS.includes(days) ? days : DEFAULT_DAYS;
}

export async function fetchShipments(swell: Pick<SwellClient, 'get'>, since: string, afterId: string | null): Promise<any[]> {
  const result = await swell.get('/shipments', {
    where: {
      date_created: { $gte: since },
      canceled: { $ne: true },
      ...(afterId ? { id: { $gt: afterId } } : {}),
    },
    sort: 'id asc',
    limit: PAGE_SIZE,
  });
  return result?.results || [];
}

// run fn over items, a few at a time
export async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  });
  await Promise.all(workers);
}

interface PageResult extends ImportStats {
  count: number;
  last_id: string | null;
  // why the run stopped before the page was sent
  stopped?: string;
}

export default class ImportShipments {
  async run(req: SwellWorkflowRequest, step: SwellWorkflowStep) {
    // step output is stored with the run, so keep only flags here, never the API key
    const check = await step.do('load settings', async () => {
      const settings = getSettings(await req.swell.settings());
      const days = parseDays((req.data as any)?.days);
      return {
        enabled: settings.enabled,
        sync_shipments: settings.sync_shipments,
        missing: missingSettings(settings),
        days,
        since: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
      };
    });

    // throw so the run ends as failed instead of completed
    if (!check.enabled) {
      throw new Error('Import not started: the AfterShip app is turned off in its settings.');
    }
    if (!check.sync_shipments) {
      throw new Error('Import not started: Send shipments to AfterShip is off in the app settings.');
    }
    if (check.missing.length) {
      throw new Error(`Import not started: add the ${check.missing.join(', ')} in Apps → AfterShip.`);
    }

    const appId = req.appId || APP_ID;
    let totals = emptyStats();
    let lastId: string | null = null;

    for (let page = 1; ; page++) {
      const afterId = lastId;
      const result = await step.do(`page ${page}`, RETRIES, async (): Promise<PageResult | { error: string }> => {
        // settings are read in each page so the API key stays out of step output
        const settings = getSettings(await req.swell.settings());
        const empty = { ...emptyStats(), count: 0, last_id: null };
        if (!settings.enabled) return { ...empty, stopped: 'the app was turned off in its settings' };
        if (!settings.sync_shipments) return { ...empty, stopped: 'Send shipments to AfterShip was turned off' };
        if (missingSettings(settings).length) return { ...empty, stopped: 'the API key was removed from the settings' };

        const shipments = await fetchShipments(req.swell, check.since, afterId);
        const stats = emptyStats();
        try {
          // shipments already sent come back as unchanged, so a retried page doesn't send them twice
          await eachLimit(shipments, CONCURRENCY, async (shipment) => {
            const { status, reason } = await syncShipment(req.swell, settings, shipment, { appId, adminUrl: req.store?.admin_url });
            stats[status as SyncStatus]++;
            if (status === 'failed') console.error(`AfterShip: shipment ${shipment.id} not sent: ${reason}`);
          });
        } catch (err) {
          // step.do retries every thrown error, so a bad API key or a forbidden call is returned and fails the run
          if (err instanceof AfterShipError && !err.retryable) {
            console.error(`AfterShip: import failed: ${err.detail}`);
            return { error: connectionError(err) };
          }
          throw err;
        }
        return { ...stats, count: shipments.length, last_id: shipments[shipments.length - 1]?.id ?? null };
      });

      if ('error' in result) {
        throw new Error(`Import failed on page ${page}. ${result.error} Before failing: ${totalsText(totals)}.`);
      }
      if (result.stopped) {
        throw new Error(`Import stopped: ${result.stopped}. Before stopping: ${totalsText(totals)}.`);
      }

      totals = addStats(totals, result);
      lastId = result.last_id;
      if (result.count < PAGE_SIZE || !lastId) {
        break;
      }
    }

    console.log(`AfterShip: import of the last ${check.days} days finished: ${totalsText(totals)}`);
    return totals;
  }
}
