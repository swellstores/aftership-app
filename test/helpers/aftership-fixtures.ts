import { vi } from "vitest";
import { getSettings, type AfterShipSettings } from "../../functions/lib/aftership";

// raw settings as returned by swell.settings()
export const rawSettings = {
  api_key: "asat_key",
  webhook_secret: "whsec",
};

export function makeSettings(overrides: Partial<AfterShipSettings> = {}): AfterShipSettings {
  return { ...getSettings({ aftership: rawSettings }), ...overrides };
}

export const ADMIN_URL = "https://shop.swell.store/admin";
export const SHIPMENT_ID = "6acf745cdb7b280012017784";

export function makeShipment(overrides: Record<string, any> = {}) {
  return {
    id: SHIPMENT_ID,
    number: "S100012",
    order_id: "ord_1",
    carrier: "usps",
    carrier_name: "USPS",
    tracking_code: "9434600208192110055280",
    date_created: "2026-10-10T12:00:00.000Z",
    destination: { name: "Jane Doe", city: "Austin", state: "TX", zip: "78701", country: "US", phone: "(415) 555-2671" },
    ...overrides,
  };
}

export function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: "ord_1",
    number: "1042",
    date_created: "2026-10-09T10:00:00.000Z",
    account_id: "acc_1",
    account: { id: "acc_1", email: "jane@example.com", first_name: "Jane", last_name: "Doe" },
    shipping: { name: "Jane Doe", country: "US" },
    ...overrides,
  };
}

export function makeTracking(overrides: Record<string, any> = {}) {
  return {
    id: "trk_1",
    tracking_number: "9434600208192110055280",
    slug: "usps",
    tag: "InTransit",
    subtag: "InTransit_001",
    subtag_message: "In transit",
    updated_at: "2026-10-12T08:00:00+00:00",
    aftership_tracking_url: "https://acme.aftership.com/9434600208192110055280",
    latest_estimated_delivery: { datetime: "2026-10-15" },
    custom_fields: { swell_shipment_id: SHIPMENT_ID, swell_order_id: "ord_1" },
    checkpoints: [
      { message: "Accepted", checkpoint_time: "2026-10-10T15:00:00-05:00", city: "Austin", state: "TX" },
      { message: "Arrived at facility", checkpoint_time: "2026-10-11T09:00:00-05:00", location: "Dallas, TX" },
    ],
    ...overrides,
  };
}

// the app's values on a shipment that was sent
export function sentShipment(values: Record<string, any> = {}, overrides: Record<string, any> = {}) {
  return makeShipment({
    $app: {
      aftership: {
        tracking_id: "trk_1",
        synced: "usps:9434600208192110055280",
        status: "InTransit",
        updated_at: "2026-10-11T08:00:00+00:00",
        ...values,
      },
    },
    ...overrides,
  });
}

type Reply = { status: number; body?: any } | Error;

export interface Routes {
  create?: Reply | Reply[];
  list?: Reply;
  get?: Reply;
  remove?: Reply;
  couriers?: Reply;
}

export const ok = (data: any, status = 200): Reply => ({ status, body: { meta: { code: status }, data } });
export const fail = (status: number, code: number, message: string): Reply => ({
  status,
  body: { meta: { code, message, type: "Error" }, data: {} },
});

function respond(reply: Reply): Response {
  if (reply instanceof Error) {
    throw reply;
  }
  const text = reply.body === undefined ? null : JSON.stringify(reply.body);
  return new Response(text, { status: reply.status });
}

// Mocks global fetch by AfterShip endpoint; create replies are taken in order (the last one repeats)
export function mockAfterShip(routes: Routes = {}) {
  const creates = Array.isArray(routes.create) ? [...routes.create] : [routes.create ?? ok(makeTracking(), 201)];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = init?.method || "GET";
    const path = url.pathname.replace("/tracking/2026-07", "");
    if (path === "/trackings" && method === "POST") return respond(creates.length > 1 ? creates.shift()! : creates[0]);
    if (path === "/trackings" && method === "GET") return respond(routes.list ?? ok({ trackings: [makeTracking()] }));
    if (path.startsWith("/trackings/") && method === "GET") return respond(routes.get ?? ok(makeTracking()));
    if (path.startsWith("/trackings/") && method === "DELETE") return respond(routes.remove ?? ok(makeTracking()));
    if (path === "/couriers") return respond(routes.couriers ?? ok({ couriers: [{ slug: "usps", name: "USPS" }], total: 1 }));
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
}

// method, url, headers and parsed body of a fetch call
export function callOf(call: any[]) {
  const [url, init] = call;
  return {
    method: init?.method || "GET",
    url: String(url),
    headers: init?.headers || {},
    body: init?.body ? JSON.parse(init.body) : undefined,
  };
}

// fetch calls to an AfterShip path (without the version prefix), e.g. "/trackings"
export function callsTo(fetchMock: { mock: { calls: any[][] } }, path: string, method?: string) {
  return fetchMock.mock.calls
    .map(callOf)
    .filter((call) => new URL(call.url).pathname.replace("/tracking/2026-07", "") === path && (!method || call.method === method));
}

// Swell client mock: get answers by path and query, put records writes
export function makeSwell(records: Record<string, any> = {}, settings: any = rawSettings) {
  const pages: any[][] = [...(records.pages ?? [])];
  return {
    get: vi.fn(async (path: string, query?: any) => {
      if (path === "/shipments/{id}") return "shipment" in records ? records.shipment : makeShipment();
      if (path === "/orders/{id}") return "order" in records ? records.order : makeOrder();
      if (path === "/shipments") {
        const where = query?.where || {};
        if (where.order_id) return { results: records.orderShipments ?? [] };
        if (typeof where["$app.aftership.tracking_id"] === "string") return { results: records.found ?? [] };
        if (where["$app.aftership.status"]) return { results: records.inTransit ?? [] };
        if (where.date_created) return { results: pages.shift() ?? [] };
      }
      return null;
    }),
    put: vi.fn().mockResolvedValue({}),
    settings: vi.fn().mockResolvedValue({ aftership: settings }),
  };
}

// the app values written to a path
export function putsTo(swell: { put: { mock: { calls: any[][] } } }, path: string) {
  return swell.put.mock.calls.filter(([p]) => p === path).map(([, body]) => body.$app.aftership);
}
