import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ImportShipments, {
  CONCURRENCY,
  PAGE_SIZE,
  addStats,
  config,
  eachLimit,
  emptyStats,
  fetchShipments,
  parseDays,
  totalsText,
  runEnv,
} from "../../functions/import-shipments";
import { callsTo, fail, makeShipment, makeSwell, mockAfterShip, rawSettings, sentShipment } from "../helpers/aftership-fixtures";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const shipments = (n: number, prefix = "s") =>
  Array.from({ length: n }, (_, i) => makeShipment({ id: `${prefix}${String(i).padStart(3, "0")}`, tracking_code: `${prefix}${i}` }));

describe("stats", () => {
  it("starts at zero, sums and describes totals", () => {
    expect(emptyStats()).toEqual({ created: 0, linked: 0, unchanged: 0, skipped: 0, failed: 0 });
    const totals = addStats({ created: 1, linked: 1, unchanged: 1, skipped: 1, failed: 1 }, { created: 2, failed: 1 });
    expect(totals).toEqual({ created: 3, linked: 1, unchanged: 1, skipped: 1, failed: 2 });
    expect(totalsText(totals)).toBe("sent 3, linked to existing trackings 1, already sent 1, skipped 1, failed 2");
  });
});

describe("parseDays", () => {
  it("accepts the modal's options only", () => {
    expect(parseDays("7")).toBe(7);
    expect(parseDays(90)).toBe(90);
    expect(parseDays("365")).toBe(30);
    expect(parseDays(undefined)).toBe(30);
  });
});

describe("fetchShipments", () => {
  it("pages by id through shipments created since the date, without canceled ones", async () => {
    const get = vi.fn().mockResolvedValue({ results: [makeShipment()] });
    expect(await fetchShipments({ get }, "2026-09-14T00:00:00.000Z", null)).toHaveLength(1);
    expect(get).toHaveBeenCalledWith("/shipments", {
      where: { date_created: { $gte: "2026-09-14T00:00:00.000Z" }, canceled: { $ne: true } },
      sort: "id asc",
      limit: PAGE_SIZE,
    });
    await fetchShipments({ get }, "x", "abc");
    expect(get.mock.calls[1][1].where.id).toEqual({ $gt: "abc" });
    expect(await fetchShipments({ get: vi.fn().mockResolvedValue(null) }, "x", null)).toEqual([]);
  });
});

describe("eachLimit", () => {
  it("runs every item with limited concurrency", async () => {
    let running = 0;
    let peak = 0;
    const seen: number[] = [];
    await eachLimit([1, 2, 3, 4, 5, 6, 7], CONCURRENCY, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      seen.push(n);
      running--;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(CONCURRENCY);
    await eachLimit([], 3, async () => {
      throw new Error("not called");
    });
  });
});

describe("import-shipments workflow", () => {
  it("is a workflow the Send existing shipments action starts", () => {
    expect(config).toMatchObject({ kind: "workflow", action: true });
  });

  it("takes the environment from the run", () => {
    expect(runEnv({ environmentId: "test" })).toBe("test");
    expect(runEnv({ environmentId: null })).toBeNull();
  });

  it("links trackings to the order in the dashboard of the run's environment", async () => {
    for (const [env, path] of [["test", "/admin/test"], [null, "/admin"]] as const) {
      vi.restoreAllMocks();
      const fetchMock = mockAfterShip();
      const { req } = makeReq([shipments(1)], rawSettings, { days: "30" }, env);
      await new ImportShipments().run(req, makeStep().step);
      expect(callsTo(fetchMock, "/trackings", "POST")[0].body.order_id_path).toBe(`https://shop.swell.store${path}/orders/ord_1`);
    }
  });

  function makeStep() {
    const names: string[] = [];
    const outputs: any[] = [];
    const step = {
      do: vi.fn(async (name: string, ...args: any[]) => {
        names.push(name);
        const output = await args[args.length - 1]();
        outputs.push(output);
        return output;
      }),
      sleep: vi.fn(),
      sleepUntil: vi.fn(),
    };
    return { step: step as unknown as SwellWorkflowStep, names, outputs };
  }

  // a run the action started; a workflow may get only the store id
  function makeReq(pages: any[][], settings: any = rawSettings, data: any = { days: "30" }, environmentId: string | null = null) {
    const swell = makeSwell({ pages }, settings);
    const req = { swell, data, appId: "aftership", environmentId, store: { id: "shop" }, workflow: { trigger: "action" } } as unknown as SwellWorkflowRequest;
    return { req, swell };
  }

  it("doesn't start when the app is off, sending is off or the key is missing", async () => {
    const fetchMock = mockAfterShip();
    const run = (settings: any) => new ImportShipments().run(makeReq([], settings).req, makeStep().step);
    await expect(run({ ...rawSettings, enabled: false })).rejects.toThrow("Import not started: the AfterShip app is turned off in its settings.");
    await expect(run({ ...rawSettings, sync_shipments: false })).rejects.toThrow(
      "Import not started: Send shipments to AfterShip is off in the app settings.",
    );
    await expect(run({})).rejects.toThrow("Import not started: add the API key in Apps → AfterShip.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the API key out of step output", async () => {
    mockAfterShip();
    const { step, outputs } = makeStep();
    await new ImportShipments().run(makeReq([shipments(2)]).req, step);
    expect(JSON.stringify(outputs)).not.toContain("asat_key");
    expect(JSON.stringify(outputs)).not.toContain("whsec");
  });

  it("sends every page from the chosen period", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-14T00:00:00Z") });
    const fetchMock = mockAfterShip();
    const page2 = [
      ...shipments(2, "t"),
      sentShipment({}, { id: "t900" }),
      makeShipment({ id: "t901", tracking_code: "" }),
    ];
    const { req, swell } = makeReq([shipments(PAGE_SIZE), page2], rawSettings, { days: "7" });
    const { step, names } = makeStep();

    const totals = await new ImportShipments().run(req, step);

    expect(totals).toEqual({ created: PAGE_SIZE + 2, linked: 0, unchanged: 1, skipped: 1, failed: 0 });
    expect(names).toEqual(["load settings", "page 1", "page 2"]);
    expect(swell.get.mock.calls.find(([p]) => p === "/shipments")?.[1].where.date_created).toEqual({ $gte: "2026-10-07T00:00:00.000Z" });
    expect(callsTo(fetchMock, "/trackings", "POST")).toHaveLength(PAGE_SIZE + 2);
  });

  it("counts existing trackings, and fails the run when any shipment failed so the dashboard shows a red popup", async () => {
    mockAfterShip({ create: [fail(400, 4005, "Invalid tracking number"), fail(400, 4003, "exists")] });
    const { req } = makeReq([shipments(3)]);
    await expect(new ImportShipments().run(req, makeStep().step)).rejects.toThrow(
      "Import finished, but 1 shipment failed; the reasons are on each order's AfterShip tab. Totals: sent 0, linked to existing trackings 2, already sent 0, skipped 0, failed 1.",
    );
  });

  it("fails when AfterShip refused every shipment it was sent", async () => {
    mockAfterShip({ create: fail(400, 4005, "Invalid tracking number") });
    const { req } = makeReq([[...shipments(2), makeShipment({ id: "s900", tracking_code: "" })]]);
    await expect(new ImportShipments().run(req, makeStep().step)).rejects.toThrow(
      "Import finished, but AfterShip refused all 2 shipments it was sent; the reasons are on each order's AfterShip tab. Totals: sent 0, linked to existing trackings 0, already sent 0, skipped 1, failed 2.",
    );
  });

  it("fails right away on credential errors with the totals so far", async () => {
    mockAfterShip({ create: fail(401, 401, "Invalid API key") });
    const { req } = makeReq([shipments(2)]);
    await expect(new ImportShipments().run(req, makeStep().step)).rejects.toThrow(
      `Import failed on page 1. AfterShip rejected the API key (401 Unauthorized). Check the API key in the app settings: copy it again from AfterShip → Settings → API keys, and use a key with the "API key" authentication type (AES and RSA signature keys aren't supported). Before failing: sent 0, linked to existing trackings 0, already sent 0, skipped 0, failed 0.`,
    );
  });

  it("throws temporary errors so the step is retried", async () => {
    mockAfterShip({ create: fail(503, 503, "down") });
    const { req } = makeReq([shipments(1)]);
    await expect(new ImportShipments().run(req, makeStep().step)).rejects.toMatchObject({ status: 503 });
  });

  it("stops when the settings change during the run", async () => {
    const fetchMock = mockAfterShip();
    for (const [change, reason] of [
      [{ enabled: false }, "the app was turned off in its settings"],
      [{ sync_shipments: false }, "Send shipments to AfterShip was turned off"],
      [{ api_key: "" }, "the API key was removed from the settings"],
    ] as const) {
      const { req, swell } = makeReq([shipments(1)]);
      swell.settings.mockResolvedValueOnce({ aftership: rawSettings }).mockResolvedValue({ aftership: { ...rawSettings, ...change } });
      await expect(new ImportShipments().run(req, makeStep().step)).rejects.toThrow(`Import stopped: ${reason}. Before stopping:`);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finishes on an empty first page", async () => {
    const { req } = makeReq([]);
    expect(await new ImportShipments().run(req, makeStep().step)).toEqual(emptyStats());
  });
});
