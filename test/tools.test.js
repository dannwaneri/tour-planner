import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveArtist, fanMap, fanPlaces, openingActs, MIN_CELLS, MAX_CANDIDATES } from "../src/tools.js";
import { fakeQloo, is, cells, ID } from "./helpers.js";

const heatFor = (byId) => [
  (u) => u.pathname === "/v2/insights" && u.searchParams.get("filter.type") === "urn:heatmap",
  (u) => ({ body: { results: { heatmap: byId[u.searchParams.get("signal.interests.entities")] ?? [] } } }),
];
const similarFor = (list) => [
  (u) => u.pathname === "/v2/insights" && u.searchParams.get("filter.type") === "urn:entity:artist" && u.searchParams.has("signal.interests.entities"),
  () => ({ body: { results: { entities: list } } }),
];

test("resolve: one exact match is ok", async () => {
  const { qloo } = fakeQloo([[is("/search"), () => ({ body: { results: [{ entity_id: ID(1), name: "Phyno", disambiguation: "Nigerian rapper" }, { entity_id: ID(2), name: "Phyno Fino" }] } })]]);
  const r = await resolveArtist(qloo, { name: "phyno" });
  assert.equal(r.status, "ok");
  assert.equal(r.results[0].artist_id, ID(1));
  assert.equal(r.provenance[0].path, "/search");
});

test("resolve: two exact matches ask the user (the Lionheart case)", async () => {
  const { qloo } = fakeQloo([[is("/search"), () => ({ body: { results: [{ entity_id: ID(1), name: "Lionheart" }, { entity_id: ID(2), name: "Lionheart" }] } })]]);
  const r = await resolveArtist(qloo, { name: "Lionheart" });
  assert.equal(r.status, "needs_input");
  assert.equal(r.results.length, 2);
});

test("resolve: no results is empty; bad input is rejected", async () => {
  const { qloo } = fakeQloo([[is("/search"), () => ({ body: { results: [] } })]]);
  assert.equal((await resolveArtist(qloo, { name: "zzzz" })).status, "empty");
  await assert.rejects(resolveArtist(qloo, { name: "x".repeat(81) }), (e) => e.code === "BAD_INPUT");
});

test("fan_map: artist with enough data uses its own map, no proxy", async () => {
  const { qloo } = fakeQloo([heatFor({ [ID(1)]: cells(MIN_CELLS) })]);
  const r = await fanMap(qloo, { artist_id: ID(1), artist_name: "Wizkid", city: "london" });
  assert.equal(r.source, "artist");
  assert.equal(r.proxy, null);
  assert.equal(r.area_count, MIN_CELLS);
});

test("fan_map: thin artist uses the first similar artist with enough data, skipping empty ones", async () => {
  const { qloo } = fakeQloo([
    heatFor({ [ID(1)]: cells(1), [ID(2)]: [], [ID(3)]: cells(MIN_CELLS - 1), [ID(4)]: cells(900), [ID(5)]: cells(2000) }),
    similarFor([{ entity_id: ID(2), name: "Starboy" }, { entity_id: ID(3), name: "Small" }, { entity_id: ID(4), name: "Davido" }, { entity_id: ID(5), name: "Later" }]),
  ]);
  const r = await fanMap(qloo, { artist_id: ID(1), artist_name: "Phyno", city: "London" });
  assert.equal(r.source, "proxy");
  assert.equal(r.proxy.name, "Davido");
  assert.deepEqual(r.tried.map((t) => t.cells), [1, 0, MIN_CELLS - 1, 900]);
  assert.match(r.summary, /Proxy data/);
});

test("fan_map: tries at most MAX_CANDIDATES similar artists, then says there is no map", async () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ entity_id: ID(100 + i), name: `A${i}` }));
  const { qloo, fetchImpl } = fakeQloo([heatFor({}), similarFor(many)]);
  const r = await fanMap(qloo, { artist_id: ID(1), artist_name: "Nobody", city: "Houston" });
  assert.equal(r.status, "empty");
  assert.equal(r.source, "none");
  const heatCalls = fetchImpl.calls.filter((u) => u.searchParams.get("filter.type") === "urn:heatmap").length;
  assert.equal(heatCalls, 1 + MAX_CANDIDATES);
});

test("fan_map: unsupported city is refused before any Qloo call", async () => {
  const { qloo, fetchImpl } = fakeQloo([]);
  await assert.rejects(fanMap(qloo, { artist_id: ID(1), city: "Tokyo" }), (e) => e.code === "UNSUPPORTED_CITY");
  await assert.rejects(fanMap(qloo, { artist_id: "not an id!", city: "London" }), (e) => e.code === "BAD_INPUT");
  assert.equal(fetchImpl.calls.length, 0);
});

test("fan_places: flags live music and event space, keeps coordinates", async () => {
  const { qloo } = fakeQloo([[(u) => u.searchParams.get("filter.type") === "urn:entity:place", () => ({ body: { results: { entities: [
    { entity_id: ID(7), name: "Club A", location: { lat: 51.5, lon: -0.1 }, query: { affinity: 0.9 }, properties: { live_music: true, neighborhood: "Peckham", primary_genre: { id: "urn:tag:genre:place:restaurant:west_african", name: "West African restaurant" } } },
    { entity_id: ID(8), name: "Cafe B", location: { lat: 51.4, lon: -0.2 }, properties: {} },
  ] } } })]]);
  const r = await fanPlaces(qloo, { artist_id: ID(1), city: "London" });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.results.map((p) => p.live_music), [true, false]);
  assert.equal(r.results[0].neighborhood, "Peckham");
  assert.equal(r.results[0].kind, "West African restaurant");
  assert.equal(r.results[1].kind, null);
  assert.match(r.summary, /1 have live music/);
});

test("Qloo 400 'entities invalid' becomes empty, not a crash (the Asake case)", async () => {
  const { qloo } = fakeQloo([[(u) => u.pathname === "/v2/insights", () => ({ status: 400, body: { errors: [{ message: "All of the provided signal.interests.entities were invalid." }] } })]]);
  const r = await fanPlaces(qloo, { artist_id: ID(1), city: "London" });
  assert.equal(r.status, "empty");
  assert.match(r.provenance[0].note, /invalid/);
});

test("opening_acts: keeps shared-fan and local-scene lists apart, drops the artist itself", async () => {
  const { qloo } = fakeQloo([
    similarFor([{ entity_id: ID(2), name: "Olamide" }]),
    [(u) => u.searchParams.get("filter.tags") === "urn:tag:genre:music:afrobeats", () => ({ body: { results: { entities: [{ entity_id: ID(1), name: "Self" }, { entity_id: ID(3), name: "Amaarae" }] } } })],
  ]);
  const r = await openingActs(qloo, { artist_id: ID(1), city: "Toronto" });
  assert.deepEqual(r.results.map((a) => [a.name, a.list]), [["Olamide", "shared_fans"], ["Amaarae", "local_scene"]]);
});

test("opening_acts: artists Qloo marks with end_year go to not_active and are named in the summary (the Dagrin case)", async () => {
  const { qloo } = fakeQloo([
    similarFor([{ entity_id: ID(2), name: "Olamide" }, { entity_id: ID(4), name: "Dagrin", properties: { end_year: 2010 } }]),
    [(u) => u.searchParams.get("filter.tags") === "urn:tag:genre:music:afrobeats", () => ({ body: { results: { entities: [{ entity_id: ID(3), name: "Amaarae" }] } } })],
  ]);
  const r = await openingActs(qloo, { artist_id: ID(1), city: "London" });
  assert.deepEqual(r.results.map((a) => [a.name, a.list]), [["Olamide", "shared_fans"], ["Dagrin", "not_active"], ["Amaarae", "local_scene"]]);
  assert.match(r.summary, /1 active artists share fans/);
  assert.match(r.summary, /Dagrin \(2010\)/);
});
