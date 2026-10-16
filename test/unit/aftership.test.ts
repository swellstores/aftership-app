import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  API_BASE,
  AfterShipError,
  aftershipDate,
  adminUrlOf,
  aftershipRequest,
  appData,
  appValues,
  buildTracking,
  carrierSlug,
  computeSignature,
  connectionError,
  createTracking,
  customerName,
  deleteTracking,
  estimatedDelivery,
  findTracking,
  formatPhone,
  getSettings,
  getTracking,
  handleError,
  isNotFound,
  loadSettings,
  missingSettings,
  parseTags,
  safeEqual,
  statusLabel,
  swellEnv,
  syncKey,
  trackingNumber,
  trackingValues,
  verifySignature,
} from "../../functions/lib/aftership";
import {
  ADMIN_URL,
  SHIPMENT_ID,
  callsTo,
  fail,
  makeOrder,
  makeSettings,
  makeShipment,
  makeTracking,
  mockAfterShip,
  ok,
  rawSettings,
} from "../helpers/aftership-fixtures";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("appValues / appData", () => {
  it("nests values under the app id and reads them back", () => {
    expect(appValues({ a: 1 })).toEqual({ $app: { aftership: { a: 1 } } });
    expect(appValues({ a: 1 }, "x")).toEqual({ $app: { x: { a: 1 } } });
    expect(appData({ $app: { aftership: { a: 1 } } })).toEqual({ a: 1 });
    expect(appData(null)).toEqual({});
  });
});

describe("adminUrlOf / swellEnv", () => {
  it("builds the dashboard address of the store and environment", () => {
    expect(adminUrlOf({ id: "shop", admin_url: "https://shop.swell.store" })).toBe("https://shop.swell.store/admin");
    expect(adminUrlOf({ id: "shop", admin_url: "https://shop.swell.store/admin/" })).toBe("https://shop.swell.store/admin");
    expect(adminUrlOf({ id: "shop" })).toBe("https://shop.swell.store/admin");
    expect(adminUrlOf({ id: "shop", admin_url: "https://shop.swell.store" }, "test")).toBe("https://shop.swell.store/admin/test");
    expect(adminUrlOf({ id: "shop", admin_url: "https://shop.swell.store/admin/test" }, "test")).toBe("https://shop.swell.store/admin/test");
    expect(adminUrlOf({}, "test")).toBe("");
    expect(adminUrlOf(undefined)).toBe("");
  });

  it("reads the test environment only from an exact Swell-Env header", () => {
    expect(swellEnv({ headers: new Headers({ "Swell-Env": "test" }) })).toBe("test");
    expect(swellEnv({ headers: new Headers({ "Swell-Env": "Test" }) })).toBeNull();
    expect(swellEnv({ headers: new Headers() })).toBeNull();
    expect(swellEnv({})).toBeNull();
  });
});

describe("getSettings", () => {
  it("applies defaults", () => {
    expect(getSettings({})).toEqual({
      api_key: "",
      webhook_secret: "",
      enabled: true,
      sync_shipments: true,
      share_customer: true,
      delete_canceled: true,
      shipment_tags: [],
    });
  });

  it("trims values and reads saved flags and tags", () => {
    const settings = getSettings({
      aftership: { api_key: " k ", webhook_secret: " s ", enabled: false, share_customer: false, shipment_tags: "a, b,,a" },
    });
    expect(settings).toMatchObject({ api_key: "k", webhook_secret: "s", enabled: false, share_customer: false, shipment_tags: ["a", "b"] });
  });

  it("allows no tags", () => {
    expect(getSettings({ aftership: { shipment_tags: "" } }).shipment_tags).toEqual([]);
    // tags are optional: none unless entered
    expect(getSettings({ aftership: { shipment_tags: null } }).shipment_tags).toEqual([]);
    expect(getSettings({ aftership: {} }).shipment_tags).toEqual([]);
    expect(parseTags(["x", " y "])).toEqual(["x", "y"]);
    expect(parseTags(5)).toEqual([]);
  });
});

describe("missingSettings / loadSettings", () => {
  it("requires the API key", () => {
    expect(missingSettings(getSettings({}))).toEqual(["API key"]);
    expect(missingSettings(makeSettings())).toEqual([]);
  });

  it("returns null when turned off or missing the key", async () => {
    expect(await loadSettings({ settings: async () => ({ aftership: { ...rawSettings, enabled: false } }) })).toBeNull();
    expect(await loadSettings({ settings: async () => ({ aftership: {} }) })).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("AfterShip: missing API key in app settings");
    expect(await loadSettings({ settings: async () => ({ aftership: rawSettings }) })).toMatchObject({ api_key: "asat_key" });
  });
});

describe("AfterShipError", () => {
  it("formats the message and endpoint, and knows what is retryable", () => {
    const err = new AfterShipError(400, 4005, "Invalid tracking number", "POST /trackings");
    expect(err.message).toBe("AfterShip 400 (4005): Invalid tracking number");
    expect(err.detail).toBe("AfterShip 400 (4005): Invalid tracking number (POST /trackings)");
    expect(err.retryable).toBe(false);
    expect(new AfterShipError(401, 401, "x").message).toBe("AfterShip 401: x");
    expect(new AfterShipError(0, undefined, "x").retryable).toBe(true);
    expect(new AfterShipError(429, 429, "x").retryable).toBe(true);
    expect(new AfterShipError(503, 503, "x").retryable).toBe(true);
  });
});

describe("aftershipRequest", () => {
  it("sends the API key and returns the data object", async () => {
    const fetchMock = mockAfterShip();
    const data = await aftershipRequest(makeSettings(), "POST", "/trackings", { tracking_number: "1" });
    expect(data.id).toBe("trk_1");
    const [call] = callsTo(fetchMock, "/trackings", "POST");
    expect(call.url).toBe(`${API_BASE}/trackings`);
    expect(call.headers).toMatchObject({ "as-api-key": "asat_key", "content-type": "application/json" });
    expect(call.body).toEqual({ tracking_number: "1" });
  });

  it("throws AfterShip's meta code and message with the endpoint", async () => {
    mockAfterShip({ get: fail(404, 4004, "Tracking does not exist.") });
    const err = await aftershipRequest(makeSettings(), "GET", "/trackings/x?fields=a").catch((e) => e);
    expect(err).toBeInstanceOf(AfterShipError);
    expect(err).toMatchObject({ status: 404, code: 4004, endpoint: "GET /trackings/x" });
    expect(err.message).toContain("Tracking does not exist.");
  });

  it("handles bodies that aren't JSON and network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("Bad gateway", { status: 502 }));
    await expect(aftershipRequest(makeSettings(), "GET", "/couriers")).rejects.toMatchObject({ status: 502, code: undefined });
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("dns"));
    await expect(aftershipRequest(makeSettings(), "GET", "/couriers")).rejects.toMatchObject({ status: 0, retryable: true });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await aftershipRequest(makeSettings(), "DELETE", "/trackings/x")).toBeNull();
  });
});

describe("statusLabel", () => {
  it("names AfterShip tags", () => {
    expect(statusLabel("OutForDelivery")).toBe("Out for delivery");
    expect(statusLabel("NewTag")).toBe("NewTag");
    expect(statusLabel(null)).toBe("Pending");
  });
});

describe("carrierSlug", () => {
  it("maps Swell carriers to AfterShip couriers", () => {
    expect(carrierSlug({ carrier: "usps" })).toBe("usps");
    expect(carrierSlug({ carrier: "dhl_express" })).toBe("dhl");
    expect(carrierSlug({ carrier: "FedEx" })).toBe("fedex");
    expect(carrierSlug({ carrier_name: "Canada Post" })).toBe("canada-post");
    expect(carrierSlug({ carrier: "Purolator" })).toBe("purolator");
  });

  it("skips app carriers and unusable names", () => {
    expect(carrierSlug({ carrier: "app_6ac74385b432150012c194f6_shippo", carrier_name: "USPS" })).toBe("usps");
    expect(carrierSlug({ carrier: "app_6ac74385b432150012c194f6_shippo" })).toBeUndefined();
    expect(carrierSlug({ carrier_name: "Bob's courier!" })).toBeUndefined();
    expect(carrierSlug({})).toBeUndefined();
  });
});

describe("trackingNumber / syncKey", () => {
  it("uses the shipment's number, else the first package's", () => {
    expect(trackingNumber(makeShipment({ tracking_code: " 123 " }))).toBe("123");
    expect(trackingNumber(makeShipment({ tracking_code: null, packages: [{}, { tracking_code: "PKG" }] }))).toBe("PKG");
    expect(trackingNumber({})).toBe("");
  });

  it("combines courier and number", () => {
    expect(syncKey(makeShipment())).toBe("usps:9434600208192110055280");
    expect(syncKey(makeShipment({ carrier: null, carrier_name: null }))).toBe("auto:9434600208192110055280");
    expect(syncKey(makeShipment({ tracking_code: "" }))).toBe("");
  });
});

describe("formatPhone / customerName", () => {
  it("formats E.164 phones", () => {
    expect(formatPhone("(415) 555-2671", "us")).toBe("+14155552671");
    expect(formatPhone("123", "US")).toBeUndefined();
    expect(formatPhone("not a phone")).toBeUndefined();
    expect(formatPhone(null)).toBeUndefined();
  });

  it("prefers the account name, then first + last, then the shipping name", () => {
    expect(customerName({ account: { name: "Ada" } })).toBe("Ada");
    expect(customerName(makeOrder())).toBe("Jane Doe");
    expect(customerName({ account: {}, shipping: { name: "Ship To" } })).toBe("Ship To");
    expect(customerName({})).toBe("");
  });
});

describe("buildTracking", () => {
  it("sends the tracking with order, destination and customer", () => {
    expect(buildTracking(makeShipment(), makeOrder(), makeSettings({ shipment_tags: ["swell"] }), { adminUrl: `${ADMIN_URL}/` })).toEqual({
      tracking_number: "9434600208192110055280",
      slug: "usps",
      title: "Order #1042",
      order_id: "ord_1",
      order_number: "1042",
      order_date: "2026-10-09T10:00:00+00:00",
      order_id_path: `${ADMIN_URL}/orders/ord_1`,
      tracking_ship_date: "2026-10-10T12:00:00+00:00",
      destination_country_region: "USA",
      destination_state: "TX",
      destination_city: "Austin",
      destination_postal_code: "78701",
      shipment_tags: ["swell"],
      custom_fields: { swell_shipment_id: SHIPMENT_ID, swell_order_id: "ord_1" },
      customers: [{ name: "Jane Doe", email: "jane@example.com", phone_number: "+14155552671" }],
    });
  });

  it("leaves out the tags when there are none", () => {
    expect(buildTracking(makeShipment(), makeOrder(), makeSettings())).not.toHaveProperty("shipment_tags");
  });

  it("leaves out the customer when sharing is off, and the courier when detecting", () => {
    const body = buildTracking(makeShipment(), makeOrder(), makeSettings({ share_customer: false, shipment_tags: [] }), {
      autoDetect: true,
    });
    expect(body.customers).toBeUndefined();
    expect(body.slug).toBeUndefined();
    expect(body.shipment_tags).toBeUndefined();
    expect(body.order_id_path).toBeUndefined();
  });

  it("falls back to the order's shipping address and skips what's unknown", () => {
    const body = buildTracking(
      makeShipment({ destination: undefined }),
      makeOrder({ account: { email: "" }, billing: { email: "bill@example.com" }, shipping: { country: "gb", phone: "bad" } }),
      makeSettings(),
    );
    expect(body.destination_country_region).toBe("GBR");
    expect(body.customers).toEqual([{ email: "bill@example.com" }]);
  });
});

describe("aftershipDate", () => {
  it("formats dates without milliseconds, the way AfterShip accepts them", () => {
    expect(aftershipDate("2026-10-15T07:08:40.174Z")).toBe("2026-10-15T07:08:40+00:00");
    expect(aftershipDate("2026-10-15T09:08:40+02:00")).toBe("2026-10-15T07:08:40+00:00");
    expect(aftershipDate("not a date")).toBeUndefined();
    expect(aftershipDate(null)).toBeUndefined();
  });
});

describe("getTracking / findTracking", () => {
  it("loads a tracking by id", async () => {
    const fetchMock = mockAfterShip();
    expect((await getTracking(makeSettings(), "trk 1")).id).toBe("trk_1");
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/trackings/trk%201`);
  });

  it("finds a tracking by number and courier", async () => {
    const fetchMock = mockAfterShip({
      list: ok({ trackings: [makeTracking({ id: "other", slug: "ups" }), makeTracking({ id: "match" })] }),
    });
    expect((await findTracking(makeSettings(), "9434600208192110055280", "usps")).id).toBe("match");
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("tracking_numbers")).toBe("9434600208192110055280");
    expect(url.searchParams.get("slug")).toBe("usps");
  });

  it("returns null when there's none", async () => {
    mockAfterShip({ list: ok({ trackings: [] }) });
    expect(await findTracking(makeSettings(), "1")).toBeNull();
  });
});

describe("createTracking", () => {
  it("creates the tracking", async () => {
    mockAfterShip();
    expect(await createTracking(makeSettings(), makeShipment(), makeOrder())).toEqual({ tracking: makeTracking(), existing: false });
  });

  it("reuses an existing tracking for the same number", async () => {
    const fetchMock = mockAfterShip({ create: fail(400, 4003, "Tracking already exists.") });
    const result = await createTracking(makeSettings(), makeShipment(), makeOrder());
    expect(result).toEqual({ tracking: makeTracking(), existing: true });
    expect(callsTo(fetchMock, "/trackings", "GET")).toHaveLength(1);
  });

  it("lets AfterShip detect the courier when the slug is refused", async () => {
    const fetchMock = mockAfterShip({ create: [fail(400, 4010, "Invalid slug"), ok(makeTracking({ slug: "usps" }), 201)] });
    const result = await createTracking(makeSettings(), makeShipment({ carrier: "ups" }), makeOrder());
    expect(result.existing).toBe(false);
    const [first, second] = callsTo(fetchMock, "/trackings", "POST");
    expect(first.body.slug).toBe("ups");
    expect(second.body.slug).toBeUndefined();
  });

  it("throws other errors, and a refused detection", async () => {
    mockAfterShip({ create: fail(400, 4005, "Invalid tracking number") });
    await expect(createTracking(makeSettings(), makeShipment(), makeOrder())).rejects.toMatchObject({ code: 4005 });
    mockAfterShip({ create: fail(400, 4012, "Bad courier") });
    await expect(createTracking(makeSettings(), makeShipment(), makeOrder())).rejects.toMatchObject({ code: 4012 });
    mockAfterShip({ create: fail(400, 4003, "exists"), list: ok({ trackings: [] }) });
    await expect(createTracking(makeSettings(), makeShipment(), makeOrder())).rejects.toMatchObject({ code: 4003 });
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new TypeError("boom");
    });
    await expect(createTracking(makeSettings(), makeShipment(), makeOrder())).rejects.toMatchObject({ status: 0 });
  });
});

describe("deleteTracking / isNotFound", () => {
  it("deletes, and ignores trackings already gone", async () => {
    const fetchMock = mockAfterShip();
    await deleteTracking(makeSettings(), "trk_1");
    expect(callsTo(fetchMock, "/trackings/trk_1", "DELETE")).toHaveLength(1);
    mockAfterShip({ remove: fail(404, 4004, "gone") });
    await expect(deleteTracking(makeSettings(), "trk_1")).resolves.toBeUndefined();
    mockAfterShip({ remove: fail(500, 500, "down") });
    await expect(deleteTracking(makeSettings(), "trk_1")).rejects.toMatchObject({ status: 500 });
  });

  it("recognizes not-found errors", () => {
    expect(isNotFound(new AfterShipError(404, 4004, "x"))).toBe(true);
    expect(isNotFound(new AfterShipError(400, 4004, "x"))).toBe(true);
    // a 404 without AfterShip's code (e.g. a retired API version) isn't a missing tracking
    expect(isNotFound(new AfterShipError(404, 404, "x"))).toBe(false);
    expect(isNotFound(new AfterShipError(404, undefined, "x"))).toBe(false);
    expect(isNotFound(new AfterShipError(400, 4005, "x"))).toBe(false);
    expect(isNotFound(new Error("x"))).toBe(false);
  });
});

describe("trackingValues", () => {
  it("keeps status, latest scan, estimate and tracking page", () => {
    vi.useFakeTimers({ now: new Date("2026-10-12T09:00:00Z") });
    expect(trackingValues(makeTracking())).toEqual({
      tracking_id: "trk_1",
      tracking_number: "9434600208192110055280",
      courier: "usps",
      status: "InTransit",
      status_detail: "In transit",
      last_event: "Arrived at facility · Dallas, TX",
      last_event_at: "2026-10-11T09:00:00-05:00",
      estimated_delivery: "2026-10-15",
      delivered_at: null,
      tracking_url: "https://acme.aftership.com/9434600208192110055280",
      updated_at: "2026-10-12T08:00:00+00:00",
      checked_at: "2026-10-12T09:00:00.000Z",
      error: null,
    });
    vi.useRealTimers();
  });

  it("handles delivered trackings and trackings without scans", () => {
    const delivered = trackingValues(makeTracking({ tag: "Delivered", shipment_delivery_date: "2026-10-14T10:00:00Z" }));
    expect(delivered.delivered_at).toBe("2026-10-14T10:00:00Z");
    const bare = trackingValues({ id: "t", courier_tracking_link: "https://usps.com/t" });
    expect(bare).toMatchObject({ status: "Pending", last_event: null, tracking_url: "https://usps.com/t", estimated_delivery: null });
    const city = trackingValues(makeTracking({ checkpoints: [{ message: "", city: "Austin", country_region: "USA" }] }));
    expect(city.last_event).toBe("Austin, USA");
  });

  it("uses the next best estimate", () => {
    expect(estimatedDelivery({ aftership_estimated_delivery_date: { estimated_delivery_date: "a" } })).toBe("a");
    expect(estimatedDelivery({ courier_estimated_delivery_date: { estimated_delivery_date: "c" } })).toBe("c");
    expect(estimatedDelivery({})).toBeNull();
  });
});

describe("connectionError", () => {
  it("explains each kind of error", () => {
    expect(connectionError(new AfterShipError(0, undefined, "dns"))).toBe("Couldn't reach AfterShip (dns). Try again later.");
    expect(connectionError(new AfterShipError(401, 401, "x"))).toContain("rejected the API key");
    expect(connectionError(new AfterShipError(401, 401, "x"))).toContain("AES and RSA signature keys aren't supported");
    expect(connectionError(new AfterShipError(403, 403, "x", "POST /trackings"))).toBe(
      "AfterShip refused POST /trackings (403 Forbidden). Check that the API key is allowed to read and write trackings, and that your AfterShip plan includes API access.",
    );
    expect(connectionError(new AfterShipError(429, 429, "x"))).toContain("Try again in a minute");
    expect(connectionError(new AfterShipError(503, 503, "x"))).toBe("AfterShip is unavailable (503). Try again later.");
    expect(connectionError(new AfterShipError(400, 4005, "Invalid tracking number", "POST /trackings"))).toBe(
      "AfterShip refused POST /trackings: Invalid tracking number",
    );
    expect(connectionError(new Error("oops"))).toBe("Unexpected error: oops");
  });

  it("says try again only for temporary errors", () => {
    expect(connectionError(new AfterShipError(400, 4005, "x"))).not.toMatch(/try again/i);
    expect(connectionError(new AfterShipError(401, 401, "x"))).not.toMatch(/try again/i);
    expect(connectionError(new AfterShipError(403, 403, "x"))).not.toMatch(/try again/i);
  });
});

describe("handleError", () => {
  it("logs the refused call", () => {
    handleError("sending", new AfterShipError(400, 4005, "x", "POST /trackings"));
    handleError("sending", new Error("plain"));
    expect(errorSpy).toHaveBeenNthCalledWith(1, "AfterShip: sending failed: AfterShip 400 (4005): x (POST /trackings)");
    expect(errorSpy).toHaveBeenNthCalledWith(2, "AfterShip: sending failed: plain");
  });
});

describe("webhook signatures", () => {
  // printf '%s' '{"msg":{"id":"trk_1"}}' | openssl dgst -sha256 -hmac whsec -binary | base64
  const body = '{"msg":{"id":"trk_1"}}';

  it("computes base64 HMAC-SHA256 of the raw body", async () => {
    expect(await computeSignature("whsec", body)).toBe("8kGo6AqNRNiXFmgIUXAPYTJzWP+bcclrlGmEgKZUaqQ=");
    expect(await computeSignature("other", body)).not.toBe("8kGo6AqNRNiXFmgIUXAPYTJzWP+bcclrlGmEgKZUaqQ=");
  });

  it("verifies the header", async () => {
    const signature = await computeSignature("whsec", body);
    expect(await verifySignature("whsec", body, ` ${signature} `)).toBe(true);
    expect(await verifySignature("whsec", `${body} `, signature)).toBe(false);
    expect(await verifySignature("whsec", body, null)).toBe(false);
    expect(await verifySignature("", body, signature)).toBe(false);
  });

  it("compares in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
    expect(safeEqual("", "")).toBe(false);
  });
});
