// Fake Qloo for tests: no network, no key, no real Qloo data (the repo is public).
import { makeQloo, QlooError } from "../src/qloo.js";

export function memoryCache() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
}

export function memoryBudget(cap = Infinity) {
  let n = 0;
  return {
    get n() { return n; },
    spend: async () => { n += 1; if (n > cap) throw new QlooError("DAILY_CAP", "cap", 503); return n; },
  };
}

// routes: array of [predicate(url: URL) => bool, responder(url) => { status?, body }]
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (href) => {
    const url = new URL(href);
    calls.push(url);
    const route = routes.find(([match]) => match(url));
    if (!route) throw new Error(`no fake route for ${url}`);
    const { status = 200, body } = route[1](url);
    return new Response(JSON.stringify(body), { status });
  };
  fn.calls = calls;
  return fn;
}

export function fakeQloo(routes, { cap } = {}) {
  const fetchImpl = fakeFetch(routes);
  const cache = memoryCache();
  const budget = memoryBudget(cap);
  return { qloo: makeQloo({ apiKey: "test-key", cache, budget, fetchImpl }), fetchImpl, cache, budget };
}

export const is = (path, param, value) => (url) =>
  url.pathname === path && (param === undefined || url.searchParams.get(param) === value);

export const cells = (n, prefix = "gcp") =>
  Array.from({ length: n }, (_, i) => ({ location: { latitude: 51.5, longitude: -0.1, geohash: `${prefix}${String(i).padStart(4, "0")}` }, query: { affinity: 1 - i / (n + 1) } }));

export const ID = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
