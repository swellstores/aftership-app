import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MAX_TRACKING_AGE_DAYS,
  applyTracking,
  clearTracking,
  findShipment,
  getTrackingShipments,
  isShipmentError,
  isTrackingChange,
  orderStatus,
  removeShipment,
  syncShipment,
  updateOrderSummary,
} from "../../functions/lib/shipments";
import { AfterShipError } from "../../functions/lib/aftership";
import {
  ADMIN_URL,
  SHIPMENT_ID,
  callsTo,
  fail,
  makeSettings,
  makeShipment,
  makeTracking,
  makeSwell,
  mockAfterShip,
  ok,
  putsTo,
  sentShipment,
} from "../helpers/aftership-fixtures";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const shipmentPath = `/shipments/${SHIPMENT_ID}`;

describe("isTrackingChange", () => {
  it("reacts to every created event and to tracking fields on updates", () => {
    // functions get the whole shipment; the update's changed fields are in $event.data
    const updated = (changed: any) => makeShipment({ $event: { type: "shipment.updated", data: { id: SHIPMENT_ID, ...changed } } });
    expect(isTrackingChange("shipment.created", makeShipment())).toBe(true);
    expect(isTrackingChange("shipment.updated", updated({ tracking_code: "1" }))).toBe(true);
    expect(isTrackingChange("shipment.updated", updated({ packages: [] }))).toBe(true);
    expect(isTrackingChange("shipment.updated", updated({ $app: { aftership: { status: "Delivered" } } }))).toBe(false);
    expect(isTrackingChange("shipment.updated", updated({ notes: "x" }))).toBe(false);
    expect(isTrackingChange("shipment.updated", makeShipment())).toBe(true);
  });
});

describe("isShipmentError", () => {
  it("is true only for permanent errors about the shipment", () => {
    expect(isShipmentError(new AfterShipError(400, 4005, "x"))).toBe(true);
    expect(isShipmentError(new AfterShipError(401, 401, "x"))).toBe(false);
    expect(isShipmentError(new AfterShipError(403, 403, "x"))).toBe(false);
    expect(isShipmentError(new AfterShipError(500, 500, "x"))).toBe(false);
    expect(isShipmentError(new Error("x"))).toBe(false);
  });
});

describe("syncShipment", () => {
  it("creates the tracking and saves it on the shipment and order", async () => {
    const fetchMock = mockAfterShip();
    const swell = makeSwell({ orderShipments: [sentShipment()] });

    const result = await syncShipment(swell, makeSettings(), makeShipment(), { adminUrl: ADMIN_URL });

    expect(result).toEqual({ status: "created", tracking_id: "trk_1" });
    expect(swell.get).toHaveBeenCalledWith("/orders/{id}", expect.objectContaining({ id: "ord_1", expand: ["account"] }));
    expect(callsTo(fetchMock, "/trackings", "POST")[0].body).toMatchObject({ order_id_path: `${ADMIN_URL}/orders/ord_1` });
    expect(putsTo(swell, shipmentPath)[0]).toMatchObject({ tracking_id: "trk_1", synced: "usps:9434600208192110055280", status: "InTransit" });
    expect(putsTo(swell, "/orders/ord_1")[0]).toMatchObject({ aftership_status: "In transit" });
  });

  it("links to an existing tracking", async () => {
    mockAfterShip({ create: fail(400, 4003, "exists") });
    const swell = makeSwell();
    expect(await syncShipment(swell, makeSettings(), makeShipment())).toEqual({ status: "linked", tracking_id: "trk_1" });
  });

  it("skips shipments that can't or needn't be sent, without calling AfterShip", async () => {
    const fetchMock = mockAfterShip();
    const swell = makeSwell({ order: null });
    const sync = (shipment: any) => syncShipment(swell, makeSettings(), shipment);

    expect(await sync(null)).toEqual({ status: "skipped", reason: "shipment not found" });
    expect(await sync(makeShipment({ canceled: true }))).toEqual({ status: "skipped", reason: "shipment canceled" });
    expect(await sync(makeShipment({ draft: true }))).toEqual({ status: "skipped", reason: "shipment is a draft" });
    expect(await sync(makeShipment({ tracking_code: "" }))).toEqual({ status: "skipped", reason: "no tracking number" });
    expect(await sync(sentShipment())).toEqual({ status: "unchanged" });
    expect(await sync(makeShipment())).toEqual({ status: "skipped", reason: "order ord_1 not found" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(swell.put).not.toHaveBeenCalled();
  });

  it("replaces the tracking when the number changes", async () => {
    const fetchMock = mockAfterShip({ create: ok(makeTracking({ id: "trk_2" }), 201) });
    const swell = makeSwell();
    const shipment = sentShipment({}, { tracking_code: "NEW1" });

    expect(await syncShipment(swell, makeSettings(), shipment)).toEqual({ status: "created", tracking_id: "trk_2" });
    expect(callsTo(fetchMock, "/trackings/trk_1", "DELETE")).toHaveLength(1);
    expect(putsTo(swell, shipmentPath)[0]).toMatchObject({ tracking_id: "trk_2", synced: "usps:NEW1" });
  });

  it("still saves the new tracking when the old one can't be deleted", async () => {
    mockAfterShip({ create: ok(makeTracking({ id: "trk_2" }), 201), remove: fail(500, 500, "down") });
    const swell = makeSwell();
    expect((await syncShipment(swell, makeSettings(), sentShipment({}, { tracking_code: "NEW1" }))).status).toBe("created");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("couldn't delete old tracking trk_1"));
  });

  it("saves errors about the shipment and doesn't send it again", async () => {
    mockAfterShip({ create: fail(400, 4005, "Invalid tracking number") });
    const swell = makeSwell();

    const result = await syncShipment(swell, makeSettings(), makeShipment());

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("Invalid tracking number (POST /trackings)");
    expect(putsTo(swell, shipmentPath)).toEqual([
      { synced: "usps:9434600208192110055280", error: "AfterShip refused POST /trackings: Invalid tracking number" },
    ]);
  });

  it("throws credential and temporary errors without saving", async () => {
    const swell = makeSwell();
    mockAfterShip({ create: fail(401, 401, "Invalid API key") });
    await expect(syncShipment(swell, makeSettings(), makeShipment())).rejects.toMatchObject({ status: 401 });
    mockAfterShip({ create: fail(429, 429, "slow down") });
    await expect(syncShipment(swell, makeSettings(), makeShipment())).rejects.toMatchObject({ status: 429 });
    expect(swell.put).not.toHaveBeenCalled();
  });

  it("uses the given app id", async () => {
    mockAfterShip();
    const swell = makeSwell();
    await syncShipment(swell, makeSettings(), makeShipment(), { appId: "app_x" });
    expect(swell.put.mock.calls[0][1].$app.app_x.tracking_id).toBe("trk_1");
  });
});

describe("findShipment", () => {
  it("finds the shipment from the tracking's custom fields", async () => {
    const swell = makeSwell({ shipment: sentShipment() });
    expect((await findShipment(swell, makeTracking()))?.id).toBe(SHIPMENT_ID);
    expect(swell.get).toHaveBeenCalledTimes(1);
  });

  it("looks the tracking up when the custom field points elsewhere", async () => {
    const other = sentShipment({ tracking_id: "trk_other" });
    const swell = makeSwell({ shipment: other, found: [sentShipment({}, { id: "found" })] });
    expect((await findShipment(swell, makeTracking()))?.id).toBe("found");
    expect(swell.get).toHaveBeenLastCalledWith("/shipments", { where: { "$app.aftership.tracking_id": "trk_1" }, limit: 1 });
  });

  it("ignores invalid ids and returns null when nothing matches", async () => {
    const swell = makeSwell();
    expect(await findShipment(swell, makeTracking({ custom_fields: { swell_shipment_id: "../x" } }))).toBeNull();
    expect(swell.get).toHaveBeenCalledTimes(1);
  });
});

describe("applyTracking", () => {
  it("saves newer updates", async () => {
    const swell = makeSwell();
    expect(await applyTracking(swell, sentShipment(), makeTracking({ tag: "Delivered" }))).toBe(true);
    expect(putsTo(swell, shipmentPath)[0]).toMatchObject({ status: "Delivered" });
    expect(putsTo(swell, "/orders/ord_1")).toHaveLength(1);
  });

  it("ignores updates older than the saved one", async () => {
    const swell = makeSwell();
    const stale = makeTracking({ updated_at: "2026-10-01T00:00:00Z" });
    expect(await applyTracking(swell, sentShipment(), stale)).toBe(false);
    expect(swell.put).not.toHaveBeenCalled();
  });
});

describe("clearTracking / removeShipment", () => {
  it("clears the tracking and updates the order", async () => {
    const swell = makeSwell();
    await clearTracking(swell, sentShipment(), { error: "gone" });
    expect(putsTo(swell, shipmentPath)[0]).toEqual({
      tracking_id: null,
      status: null,
      status_detail: null,
      estimated_delivery: null,
      error: "gone",
    });
    expect(putsTo(swell, "/orders/ord_1")).toHaveLength(1);
  });

  it("deletes the tracking of a canceled shipment so it can be sent again", async () => {
    const fetchMock = mockAfterShip();
    const swell = makeSwell();
    expect(await removeShipment(swell, makeSettings(), sentShipment({}, { canceled: true }))).toBe("trk_1");
    expect(callsTo(fetchMock, "/trackings/trk_1", "DELETE")).toHaveLength(1);
    expect(putsTo(swell, shipmentPath)[0]).toMatchObject({ tracking_id: null, synced: null, error: null });
  });

  it("finds the tracking of a deleted shipment by number when the event has no app values", async () => {
    const fetchMock = mockAfterShip();
    const swell = makeSwell();
    expect(await removeShipment(swell, makeSettings(), makeShipment(), { deleted: true })).toBe("trk_1");
    expect(callsTo(fetchMock, "/trackings/trk_1", "DELETE")).toHaveLength(1);
    expect(putsTo(swell, shipmentPath)).toHaveLength(0);
    expect(putsTo(swell, "/orders/ord_1")).toHaveLength(1);
  });

  it("leaves trackings of other shipments alone", async () => {
    const fetchMock = mockAfterShip({ list: ok({ trackings: [makeTracking({ custom_fields: { swell_shipment_id: "other" } })] }) });
    expect(await removeShipment(makeSwell(), makeSettings(), makeShipment(), { deleted: true })).toBeNull();
    expect(await removeShipment(makeSwell(), makeSettings(), makeShipment())).toBeNull();
    expect(await removeShipment(makeSwell(), makeSettings(), makeShipment({ tracking_code: "" }), { deleted: true })).toBeNull();
    expect(callsTo(fetchMock, "/trackings/trk_1", "DELETE")).toHaveLength(0);
  });
});

describe("getTrackingShipments", () => {
  it("queries trackings that can still change, least recently checked first", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-14T00:00:00Z") });
    const swell = makeSwell({ inTransit: [sentShipment()] });
    expect(await getTrackingShipments(swell, 50)).toHaveLength(1);
    const cutoff = new Date(Date.parse("2026-10-14T00:00:00Z") - MAX_TRACKING_AGE_DAYS * 86400000).toISOString();
    expect(swell.get).toHaveBeenCalledWith("/shipments", {
      where: {
        "$app.aftership.status": {
          $in: ["Pending", "InfoReceived", "InTransit", "OutForDelivery", "AttemptFail", "AvailableForPickup", "Exception"],
        },
        canceled: { $ne: true },
        date_created: { $gte: cutoff },
      },
      sort: "$app.aftership.checked_at asc",
      limit: 50,
    });
  });

  it("leaves out shipments without a tracking", async () => {
    const swell = makeSwell({ inTransit: [sentShipment(), sentShipment({ tracking_id: null }, { id: "s2" }), makeShipment({ id: "s3" })] });
    expect((await getTrackingShipments(swell, 50)).map((s) => s.id)).toEqual([SHIPMENT_ID]);
  });

  it("returns an empty list for empty responses", async () => {
    expect(await getTrackingShipments({ get: vi.fn().mockResolvedValue(null) }, 5)).toEqual([]);
  });
});

describe("orderStatus", () => {
  it("summarizes the shipments' statuses", () => {
    expect(orderStatus([])).toBeNull();
    expect(orderStatus(["InTransit", "InTransit"])).toBe("In transit");
    expect(orderStatus(["Delivered", "Exception"])).toBe("Exception");
    expect(orderStatus(["InTransit", "AttemptFail"])).toBe("Delivery attempt failed");
    expect(orderStatus(["Delivered", "InTransit", "Pending"])).toBe("Partly delivered (1 of 3)");
    expect(orderStatus(["Pending", "OutForDelivery"])).toBe("Out for delivery");
  });
});

describe("updateOrderSummary", () => {
  const second = (values: Record<string, any>, overrides: Record<string, any> = {}) =>
    sentShipment({ tracking_id: "trk_2", ...values }, { id: "s2", number: "S100013", ...overrides });

  it("writes the status, tracking page, estimate and one line per shipment", async () => {
    const swell = makeSwell({
      orderShipments: [
        sentShipment({ courier: "usps", tracking_number: "111", status: "Delivered", delivered_at: "2026-10-12", tracking_url: "https://t/1" }),
        second({ courier: "ups", tracking_number: "222", estimated_delivery: "2026-10-16", tracking_url: "https://t/2", last_event: "Departed" }),
        second({}, { id: "s3", canceled: true }),
        makeShipment({ id: "s4" }),
      ],
    });

    await updateOrderSummary(swell, "ord_1");

    expect(swell.get).toHaveBeenCalledWith("/shipments", { where: { order_id: "ord_1" }, sort: "date_created asc", limit: 100 });
    expect(putsTo(swell, "/orders/ord_1")[0]).toEqual({
      aftership_status: "Partly delivered (1 of 2)",
      aftership_tracking_url: "https://t/2",
      aftership_estimated_delivery: "2026-10-16",
      aftership_delivered_at: null,
      aftership_shipments:
        "Shipment S100012 · USPS 111 · Delivered · https://t/1\nShipment S100013 · UPS 222 · In transit · Departed · https://t/2",
    });
  });

  it("shows the delivery date once everything is delivered", async () => {
    const swell = makeSwell({
      orderShipments: [
        sentShipment({ status: "Delivered", delivered_at: "2026-10-12T10:00:00Z", tracking_url: "https://t/1" }),
        second({ status: "Delivered", delivered_at: "2026-10-13T10:00:00Z", updated_at: "2026-10-13T10:00:00Z", tracking_url: "https://t/2" }),
      ],
    });
    await updateOrderSummary(swell, "ord_1");
    expect(putsTo(swell, "/orders/ord_1")[0]).toMatchObject({
      aftership_status: "Delivered",
      aftership_tracking_url: "https://t/2",
      aftership_estimated_delivery: null,
      aftership_delivered_at: "2026-10-13T10:00:00Z",
    });
  });

  it("lists shipments that couldn't be sent and clears an order without trackings", async () => {
    const swell = makeSwell({ orderShipments: [makeShipment({ $app: { aftership: { error: "Invalid number" } } })] });
    await updateOrderSummary(swell, "ord_1");
    expect(putsTo(swell, "/orders/ord_1")[0]).toEqual({
      aftership_status: null,
      aftership_tracking_url: null,
      aftership_estimated_delivery: null,
      aftership_delivered_at: null,
      aftership_shipments: "Shipment S100012 · Not sent: Invalid number",
    });

    const empty = makeSwell();
    await updateOrderSummary(empty, "ord_1");
    expect(putsTo(empty, "/orders/ord_1")[0].aftership_shipments).toBeNull();
    await updateOrderSummary(empty, "");
    expect(empty.put).toHaveBeenCalledTimes(1);
  });
});
