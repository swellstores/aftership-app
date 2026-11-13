import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import {
  ADMIN_URL,
  SHIPMENT_ID,
  callsTo,
  fail,
  makeShipment,
  makeSwell,
  makeTracking,
  mockAfterShip,
  ok,
  putsTo,
  rawSettings,
  sentShipment,
} from "../helpers/aftership-fixtures";
import { computeSignature } from "../../functions/lib/aftership";
import shipmentSync, { config as syncConfig, deletedShipment } from "../../functions/shipment-sync";
import { post as webhook, config as webhookConfig } from "../../functions/aftership-webhook";
import refreshTracking, { BATCH_SIZE, config as refreshConfig } from "../../functions/refresh-tracking";
import testConnection, { config as testConfig } from "../../functions/test-connection";

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// functions get the store's address as admin_url, without /admin
function request(data: Record<string, any>, records: Record<string, any> = {}, settings: any = rawSettings, headers?: Record<string, string>) {
  const swell = makeSwell(records, settings);
  const req = createMockRequest({ data, swell: swell as any, store: { id: "shop", admin_url: "https://shop.swell.store" } as any, appId: "aftership", headers });
  return { req, swell };
}

const off = { ...rawSettings, enabled: false };

// a SwellError with status 400 shows in the admin as a red error popup
async function expectFailure(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toMatchObject({ name: "SwellError", status: 400, message });
}
const shipmentPath = `/shipments/${SHIPMENT_ID}`;

describe("shipment-sync", () => {
  // like Swell: the whole shipment, with the changed fields in $event.data
  const event = (type: string, data: Record<string, any> = {}, changed: Record<string, any> = data) => ({
    id: SHIPMENT_ID,
    ...data,
    $event: { type, data: { id: SHIPMENT_ID, ...changed } },
  });

  it("subscribes to shipment events", () => {
    expect(syncConfig.model?.events).toEqual(["shipment.created", "shipment.updated", "shipment.canceled", "shipment.deleted"]);
  });

  it("sends a new shipment", async () => {
    const fetchMock = mockAfterShip();
    const { req, swell } = request(event("shipment.created"));

    await shipmentSync(req);

    expect(swell.get).toHaveBeenCalledWith("/shipments/{id}", { id: SHIPMENT_ID });
    expect(callsTo(fetchMock, "/trackings", "POST")[0].body).toMatchObject({
      tracking_number: "9434600208192110055280",
      order_id_path: `${ADMIN_URL}/orders/ord_1`,
    });
    expect(putsTo(swell, shipmentPath)[0]).toMatchObject({ tracking_id: "trk_1" });
    expect(logSpy).toHaveBeenCalledWith(`AfterShip: shipment ${SHIPMENT_ID} sent as tracking trk_1`);
  });

  it("links the tracking to the test dashboard in the test environment", async () => {
    const fetchMock = mockAfterShip();
    await shipmentSync(request(event("shipment.created"), {}, rawSettings, { "Swell-Env": "test" }).req);
    expect(callsTo(fetchMock, "/trackings", "POST")[0].body.order_id_path).toBe("https://shop.swell.store/admin/test/orders/ord_1");
  });

  it("sends a shipment when its tracking number is added later", async () => {
    const fetchMock = mockAfterShip({ create: fail(400, 4003, "exists") });
    const { req } = request(event("shipment.updated", { tracking_code: "9434600208192110055280" }));
    await shipmentSync(req);
    expect(callsTo(fetchMock, "/trackings", "POST")).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(`AfterShip: shipment ${SHIPMENT_ID} linked to tracking trk_1`);
  });

  it("ignores updates that don't touch tracking, including its own", async () => {
    const fetchMock = mockAfterShip();
    const { req, swell } = request(event("shipment.updated", sentShipment(), { $app: { aftership: { status: "InTransit" } } }));
    await shipmentSync(req);
    expect(swell.get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the app is off, the key is missing or sending is off", async () => {
    const fetchMock = mockAfterShip();
    for (const settings of [off, { ...rawSettings, api_key: "" }, { ...rawSettings, sync_shipments: false }]) {
      const { req, swell } = request(event("shipment.created"), {}, settings);
      await shipmentSync(req);
      expect(swell.get).not.toHaveBeenCalled();
      expect(swell.put).not.toHaveBeenCalled();
    }
    const { req } = request(event("shipment.canceled"), { shipment: sentShipment({}, { canceled: true }) }, off);
    await shipmentSync(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs shipments AfterShip refuses", async () => {
    mockAfterShip({ create: fail(400, 4005, "Invalid tracking number") });
    const { req } = request(event("shipment.created"));
    await shipmentSync(req);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`shipment ${SHIPMENT_ID} not sent: AfterShip 400 (4005)`));
  });

  it("logs permanent errors instead of throwing", async () => {
    mockAfterShip({ create: fail(401, 401, "Invalid API key") });
    const { req } = request(event("shipment.created"));
    await expect(shipmentSync(req)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`sending shipment ${SHIPMENT_ID} failed: AfterShip 401`));
  });

  it("rethrows temporary errors so Swell retries the event", async () => {
    mockAfterShip({ create: fail(429, 429, "slow down") });
    await expect(shipmentSync(request(event("shipment.created")).req)).rejects.toMatchObject({ status: 429 });
    mockAfterShip({ remove: fail(503, 503, "down") });
    const { req } = request(event("shipment.canceled"), { shipment: sentShipment() });
    await expect(shipmentSync(req)).rejects.toMatchObject({ status: 503 });
  });

  it("rethrows a failed Swell read or write so Swell retries the event", async () => {
    mockAfterShip();
    const { req, swell } = request(event("shipment.created"));
    swell.get.mockRejectedValueOnce(new Error("Service unavailable"));
    await expect(shipmentSync(req)).rejects.toThrow("Service unavailable");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`sending shipment ${SHIPMENT_ID} failed: Service unavailable`));
  });

  it("deletes the tracking of a canceled shipment", async () => {
    const fetchMock = mockAfterShip();
    const { req, swell } = request(event("shipment.canceled"), { shipment: sentShipment({}, { canceled: true }) });
    await shipmentSync(req);
    expect(callsTo(fetchMock, "/trackings/trk_1", "DELETE")).toHaveLength(1);
    expect(putsTo(swell, shipmentPath)[0]).toMatchObject({ tracking_id: null, synced: null });
    expect(logSpy).toHaveBeenCalledWith(`AfterShip: deleted tracking trk_1 of canceled shipment ${SHIPMENT_ID}`);
  });

  it("deletes the tracking of a deleted shipment from the event data", async () => {
    const fetchMock = mockAfterShip();
    const { req, swell } = request(event("shipment.deleted", sentShipment()));
    await shipmentSync(req);
    expect(swell.get).not.toHaveBeenCalledWith("/shipments/{id}", expect.anything());
    expect(callsTo(fetchMock, "/trackings/trk_1", "DELETE")).toHaveLength(1);
  });

  it("reads a deleted shipment from $event.data, as Swell sends only { $event }", async () => {
    const fetchMock = mockAfterShip();
    const { req, swell } = request({ $event: { type: "shipment.deleted", data: sentShipment() } });
    (req as any).data = { $event: { type: "shipment.deleted", data: sentShipment() } };
    await shipmentSync(req);
    expect(callsTo(fetchMock, "/trackings/trk_1", "DELETE")).toHaveLength(1);
    expect(putsTo(swell, "/orders/ord_1")).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(`AfterShip: deleted tracking trk_1 of deleted shipment ${SHIPMENT_ID}`);
  });

  it("does nothing for a deleted event without a shipment", async () => {
    const fetchMock = mockAfterShip();
    const { req } = request({});
    (req as any).data = { $event: { type: "shipment.deleted", data: null } };
    await shipmentSync(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deletedShipment({ id: "x" })).toEqual({ id: "x" });
    expect(deletedShipment(null)).toBeNull();
  });

  it("keeps trackings when deleting is off, and handles missing shipments and errors", async () => {
    const fetchMock = mockAfterShip({ remove: fail(400, 4015, "bad id") });
    await shipmentSync(request(event("shipment.canceled"), {}, { ...rawSettings, delete_canceled: false }).req);
    expect(fetchMock).not.toHaveBeenCalled();

    await shipmentSync(request(event("shipment.canceled"), { shipment: null }).req);
    expect(fetchMock).not.toHaveBeenCalled();

    await shipmentSync(request(event("shipment.canceled"), { shipment: makeShipment({ canceled: true }) }).req);
    expect(fetchMock).not.toHaveBeenCalled();

    await shipmentSync(request(event("shipment.canceled"), { shipment: sentShipment() }).req);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`deleting the tracking of shipment ${SHIPMENT_ID} failed`));
  });
});

describe("aftership-webhook", () => {
  const body = JSON.stringify({ event: "tracking_update", event_id: "e1", msg: { id: "trk_1", tag: "Delivered" }, ts: 1 });

  async function hook(records: Record<string, any> = {}, settings: any = rawSettings, opts: { text?: string; secret?: string; signature?: string | null } = {}) {
    const text = opts.text ?? body;
    const signature = opts.signature === undefined ? await computeSignature(opts.secret ?? "whsec", text) : opts.signature;
    const swell = makeSwell(records, settings);
    const req = createMockRequest({
      data: text.startsWith("{") ? JSON.parse(text) : {},
      swell: swell as any,
      headers: signature ? { "aftership-hmac-sha256": signature } : {},
      appId: "aftership",
    });
    (req as any).rawBody = text;
    return { req, swell, run: () => webhook(req) };
  }

  it("is a public POST route", () => {
    expect(webhookConfig.route).toEqual({ methods: ["post"], public: true });
  });

  it("loads the tracking from AfterShip and saves it", async () => {
    const fetchMock = mockAfterShip({ get: ok(makeTracking({ tag: "Delivered" })) });
    const { run, swell } = await hook({ shipment: sentShipment() });

    expect(await run()).toEqual({ received: true, processed: true });
    expect(callsTo(fetchMock, "/trackings/trk_1", "GET")).toHaveLength(1);
    expect(putsTo(swell, shipmentPath)[0]).toMatchObject({ status: "Delivered" });
  });

  it("rejects requests without a valid signature or secret", async () => {
    const fetchMock = mockAfterShip();
    await expect((await hook({}, rawSettings, { secret: "wrong" })).run()).rejects.toMatchObject({ status: 401, message: "Invalid webhook signature" });
    await expect((await hook({}, rawSettings, { signature: null })).run()).rejects.toMatchObject({ status: 401 });
    await expect((await hook({}, { ...rawSettings, webhook_secret: "" })).run()).rejects.toMatchObject({
      status: 401,
      message: "Webhook secret is not set in the app settings",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("acknowledges without calling AfterShip when the app is off or has no key", async () => {
    const fetchMock = mockAfterShip();
    expect(await (await hook({}, off)).run()).toEqual({ received: true, processed: false });
    expect(await (await hook({}, { ...rawSettings, api_key: "" })).run()).toEqual({ received: true, processed: false });
    expect(await (await hook({}, rawSettings, { text: '{"msg":{}}' })).run()).toEqual({ received: true, processed: false });
    expect(await (await hook({}, rawSettings, { text: "not json" })).run()).toEqual({ received: true, processed: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores trackings that aren't this store's, deleted ones and stale updates", async () => {
    mockAfterShip();
    expect(await (await hook({ shipment: null })).run()).toEqual({ received: true, processed: false });

    mockAfterShip({ get: fail(404, 4004, "gone") });
    expect(await (await hook()).run()).toEqual({ received: true, processed: false });

    mockAfterShip({ get: ok(makeTracking({ updated_at: "2026-01-01T00:00:00Z" })) });
    const stale = await hook({ shipment: sentShipment() });
    expect(await stale.run()).toEqual({ received: true, processed: false });
    expect(stale.swell.put).not.toHaveBeenCalled();
  });

  it("asks AfterShip to retry when the update can't be saved in Swell", async () => {
    mockAfterShip({ get: ok(makeTracking({ tag: "Delivered" })) });
    const { req, swell } = await hook({ shipment: sentShipment() });
    swell.put.mockRejectedValueOnce(new Error("Swell is down"));
    await expect(webhook(req)).rejects.toMatchObject({ status: 503, message: "Could not save the tracking update" });
  });

  it("asks AfterShip to retry temporary errors only", async () => {
    mockAfterShip({ get: fail(503, 503, "down") });
    await expect((await hook()).run()).rejects.toMatchObject({ status: 503, message: "AfterShip is unavailable (503). Try again later." });

    mockAfterShip({ get: fail(401, 401, "bad key") });
    expect(await (await hook()).run()).toEqual({ received: true, processed: false });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("webhook for tracking trk_1 failed: AfterShip 401"));
  });
});

describe("refresh-tracking", () => {
  const run = (records: Record<string, any>, settings: any = rawSettings) => {
    const { req, swell } = request({}, records, settings);
    return { swell, result: refreshTracking(req) };
  };

  it("runs every hour", () => {
    expect(refreshConfig.cron?.schedule).toBe("15 * * * *");
  });

  it("refreshes trackings still in transit", async () => {
    const fetchMock = mockAfterShip({ get: ok(makeTracking({ tag: "OutForDelivery" })) });
    const { swell, result } = run({ inTransit: [sentShipment()] });

    expect(await result).toEqual({ checked: 1, updated: 1, errors: 0 });
    expect(swell.get).toHaveBeenCalledWith("/shipments", expect.objectContaining({ limit: BATCH_SIZE }));
    expect(callsTo(fetchMock, "/trackings/trk_1", "GET")).toHaveLength(1);
    expect(putsTo(swell, shipmentPath)[0]).toMatchObject({ status: "OutForDelivery" });
  });

  it("only marks unchanged trackings as checked", async () => {
    mockAfterShip({ get: ok(makeTracking({ updated_at: "2026-01-01T00:00:00Z" })) });
    const { swell, result } = run({ inTransit: [sentShipment()] });
    expect(await result).toEqual({ checked: 1, updated: 0, errors: 0 });
    expect(Object.keys(putsTo(swell, shipmentPath)[0])).toEqual(["checked_at"]);
  });

  it("clears trackings deleted in AfterShip", async () => {
    mockAfterShip({ get: fail(404, 4004, "gone") });
    const { swell, result } = run({ inTransit: [sentShipment()] });
    expect(await result).toEqual({ checked: 1, updated: 0, errors: 0 });
    expect(putsTo(swell, shipmentPath)[0]).toMatchObject({ tracking_id: null, error: "The tracking was deleted in AfterShip." });
  });

  it("counts errors, and stops on credential errors", async () => {
    mockAfterShip({ get: fail(500, 500, "down") });
    expect(await run({ inTransit: [sentShipment(), sentShipment({}, { id: "s2" })] }).result).toEqual({ checked: 2, updated: 0, errors: 2 });

    mockAfterShip({ get: fail(401, 401, "bad key") });
    const stopped = run({ inTransit: [sentShipment(), sentShipment({}, { id: "s2" })] });
    expect(await stopped.result).toEqual({ checked: 1, updated: 0, errors: 1 });
    expect(stopped.swell.put).not.toHaveBeenCalled();
  });

  it("stops when the time budget runs out", async () => {
    mockAfterShip();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(0).mockReturnValue(60_000);
    expect(await run({ inTransit: [sentShipment()] }).result).toEqual({ checked: 0, updated: 0, errors: 0 });
  });

  it("does nothing when the app is off or has no key", async () => {
    const fetchMock = mockAfterShip();
    for (const settings of [off, { ...rawSettings, api_key: "" }]) {
      const { swell, result } = run({ inTransit: [sentShipment()] }, settings);
      expect(await result).toBeUndefined();
      expect(swell.get).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("test-connection", () => {
  const run = async (settings: any) => (await testConnection(request({}, {}, settings).req)) as { message: string };

  it("is a settings action", () => {
    expect(testConfig.action).toBe(true);
  });

  it("shows a failed settings read as a red popup with a message", async () => {
    const { req, swell } = request({});
    swell.settings.mockRejectedValue(new Error("settings unavailable"));
    await expectFailure(testConnection(req), "Test connection failed: settings unavailable");
  });

  it("reports the couriers and the webhook secret", async () => {
    const couriers = ["USPS", "UPS", "FedEx", "DHL", "Canada Post", "Royal Mail"].map((name) => ({ name, slug: name }));
    const fetchMock = mockAfterShip({ couriers: ok({ couriers }) });
    expect((await run(rawSettings)).message).toBe(
      "Connected to AfterShip. 6 couriers turned on: USPS, UPS, FedEx, DHL, Canada Post, …. Webhook secret is set.",
    );
    expect(callsTo(fetchMock, "/couriers", "GET")[0].headers["as-api-key"]).toBe("asat_key");
  });

  it("explains a missing webhook secret, no couriers and a turned-off app", async () => {
    mockAfterShip({ couriers: ok({ couriers: [] }) });
    expect((await run({ ...off, webhook_secret: "" })).message).toBe(
      "Connected to AfterShip. No couriers are turned on in AfterShip yet, so it detects the courier from each tracking number. " +
        "Add the webhook secret from AfterShip → Settings → Webhooks, or tracking updates arrive only with the hourly refresh. " +
        "The app is turned off, so nothing is sent until you turn it on.",
    );
    mockAfterShip({ couriers: ok({ couriers: [{ slug: "usps" }] }) });
    expect((await run(rawSettings)).message).toContain("1 courier turned on: usps.");
  });

  it("asks for the API key first, as a red popup", async () => {
    const fetchMock = mockAfterShip();
    await expectFailure(run({}), "Add the API key and save the settings first.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains AfterShip errors as a red popup", async () => {
    mockAfterShip({ couriers: fail(401, 401, "Invalid API key") });
    const err = await run(rawSettings).catch((e) => e);
    expect(err).toMatchObject({ name: "SwellError", status: 400 });
    expect(err.message).toContain("AfterShip rejected the API key (401 Unauthorized)");
  });
});
