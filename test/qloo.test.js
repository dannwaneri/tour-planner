import { test } from "node:test";
import assert from "node:assert/strict";
import { makeQloo, requestKey, QlooError } from "../src/qloo.js";
import { fakeQloo, is } from "./helpers.js";

test("requestKey sorts params and joins arrays, so equal requests share one cache entry", () => {
  assert.equal(requestKey("/v2/insights", { take: 5, "filter.type": "x", ids: ["a", "b"] }), requestKey("/v2/insights", { ids: ["a", "b"], "filter.type": "x", take: 5 }));
  assert.match(requestKey("/s", { ids: ["a", "b"] }), /ids=a%2Cb/);
});

test("no key fails closed before any call", () => {
  assert.throws(() => makeQloo({ apiKey: "", cache: {}, budget: {} }), (e) => e.code === "NOT_CONFIGURED");
});

test("sends the key in X-Api-Key to the hackathon base URL", async () => {
  let seen;
  const fetchImpl = async (href, init) => { seen = { href, init }; return new Response("{}", { status: 200 }); };
  const qloo = makeQloo({ apiKey: "k", cache: { get: async () => null, put: async () => {} }, budget: { spend: async () => 1 }, fetchImpl });
  await qloo("/search", { query: "x" });
  assert.ok(seen.href.startsWith("https://hackathon.api.qloo.com/search?"));
  assert.equal(seen.init.headers["X-Api-Key"], "k");
});

test("second identical call is served from cache and does not spend budget", async () => {
  const { qloo, fetchImpl, budget } = fakeQloo([[is("/search"), () => ({ body: { results: [] } })]]);
  const a = await qloo("/search", { query: "Burna Boy" });
  const b = await qloo("/search", { query: "Burna Boy" });
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(budget.n, 1);
});

test("daily cap stops upstream calls", async () => {
  const { qloo, fetchImpl } = fakeQloo([[is("/search"), () => ({ body: { results: [] } })]], { cap: 1 });
  await qloo("/search", { query: "a" });
  await assert.rejects(qloo("/search", { query: "b" }), (e) => e.code === "DAILY_CAP");
  assert.equal(fetchImpl.calls.length, 1);
});

test("maps upstream errors to clear codes and does not cache them", async () => {
  const { qloo, cache } = fakeQloo([
    [is("/search", "query", "auth"), () => ({ status: 401, body: {} })],
    [is("/search", "query", "slow"), () => ({ status: 429, body: {} })],
    [is("/search", "query", "bad"), () => ({ status: 400, body: { errors: [{ message: "All of the provided signal.interests.entities were invalid." }] } })],
  ]);
  await assert.rejects(qloo("/search", { query: "auth" }), (e) => e instanceof QlooError && e.code === "QLOO_AUTH");
  await assert.rejects(qloo("/search", { query: "slow" }), (e) => e.code === "QLOO_RATE_LIMIT");
  await assert.rejects(qloo("/search", { query: "bad" }), (e) => e.code === "QLOO_BAD_REQUEST" && /invalid/.test(e.message));
  assert.equal(cache.m.size, 0);
});
