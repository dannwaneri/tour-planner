// Qloo tools for the tour planner. Each tool returns one envelope shape (modelled on the kit's):
//   { status: "ok" | "empty" | "needs_input" | "error", summary, results, provenance }
// provenance lists every Qloo request behind the answer, so the UI can tag each claim with its source.
// Only artist names, entity IDs and city names are sent to Qloo — never personal data.

import { QlooError } from "./qloo.js";

// The user picks the city. Our city-audience ranking test returned empty results for most cities, and
// thin-data artists have too little heatmap data for region-wide ranking (see README, Known limits).
export const CITIES = [
  "London", "Manchester", "Birmingham", "Dublin", "Paris",
  "Houston", "Atlanta", "New York City", "Washington DC", "Dallas", "Toronto",
  "Lagos", "Accra", "Johannesburg",
];
// Measured 2026-10-21: other "Afrobeats" tag types exist; this genre tag gave city lists.
export const AFROBEATS_TAG = "urn:tag:genre:music:afrobeats";

// Proxy rule from PLAN.md, tested by scripts/proxy.mjs (London: 10/10 for Tems and Wizkid).
export const MIN_CELLS = 200;
export const MAX_CANDIDATES = 8;
const MAP_CELLS = 300; // cells sent to the browser map

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
const idOf = (e) => e?.entity_id ?? e?.id ?? null;
const affOf = (e) => e?.query?.affinity ?? e?.affinity ?? null;
const listOf = (body, key) => (Array.isArray(body?.results) ? body.results : body?.results?.[key] ?? []);

const areas = (n) => `${n} ${n === 1 ? "area" : "areas"}`;
const envelope = (status, summary, results, provenance) => ({ status, summary, results, result_count: results.length, provenance });

function checkCity(city) {
  const match = CITIES.find((c) => norm(c) === norm(city));
  if (!match) throw new QlooError("UNSUPPORTED_CITY", `Pick one of: ${CITIES.join(", ")}.`, 400);
  return match;
}
function checkId(id, field = "artist_id") {
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new QlooError("BAD_INPUT", `${field} must be a Qloo entity ID.`, 400);
  return id;
}

// Qloo answers 400 "entities were invalid" for some IDs that /search returns (seen for Asake → movies).
// Treat that as "no data", not as a crash.
async function insightsOrEmpty(qloo, params, prov) {
  try {
    const r = await qloo("/v2/insights", params);
    prov.push({ ...r.request, cached: r.cached });
    return r.body;
  } catch (e) {
    if (e instanceof QlooError && e.code === "QLOO_BAD_REQUEST") {
      prov.push({ path: "/v2/insights", params, note: e.message });
      return null;
    }
    throw e;
  }
}

// 1. Resolve a typed name to one Qloo artist. Ambiguous names go back to the user ("Lionheart" lesson).
export async function resolveArtist(qloo, { name }) {
  if (typeof name !== "string" || !name.trim() || name.length > 80) throw new QlooError("BAD_INPUT", "name must be 1-80 characters.", 400);
  const r = await qloo("/search", { query: name.trim(), types: "urn:entity:artist", take: 5 });
  const prov = [{ ...r.request, cached: r.cached }];
  const candidates = listOf(r.body, "entities").map((e) => ({
    artist_id: idOf(e), name: e?.name, popularity: e?.popularity ?? null, description: e?.disambiguation ?? e?.properties?.short_description ?? null,
  })).filter((c) => c.artist_id);
  if (!candidates.length) return envelope("empty", `Qloo has no artist named "${name}".`, [], prov);
  const exact = candidates.filter((c) => norm(c.name) === norm(name));
  if (exact.length === 1) return envelope("ok", `Matched ${exact[0].name}.`, [exact[0], ...candidates.filter((c) => c !== exact[0])], prov);
  return envelope("needs_input", exact.length > 1 ? `${exact.length} artists share the name "${name}". Ask the user which one.` : `No exact match for "${name}". Ask the user to pick one.`, candidates, prov);
}

// Qloo sets properties.end_year on artists who stopped performing (died, or the group split).
// Seen on 11 of 608 artists in our tests, all correct (Dagrin 2010, Tony Allen 2020...). It is not complete:
// Fela Kuti (died 1997) has none. So we filter on it AND say the check is not complete.
const artistRow = (e) => ({ artist_id: idOf(e), name: e?.name, affinity: affOf(e), end_year: e?.properties?.end_year ?? null });

// 2. Artists whose fans overlap, in Qloo's order.
export async function similarArtists(qloo, { artist_id, take = 10 }) {
  checkId(artist_id);
  const prov = [];
  const body = await insightsOrEmpty(qloo, { "filter.type": "urn:entity:artist", "signal.interests.entities": artist_id, take: Math.min(Number(take) || 10, 20) }, prov);
  const results = listOf(body, "entities").filter((e) => idOf(e) && idOf(e) !== artist_id)
    .map(artistRow);
  return envelope(results.length ? "ok" : "empty", results.length ? `${results.length} artists share fans with this artist.` : "Qloo has no fan-overlap data for this artist.", results, prov);
}

// Heatmap cells inside a city, strongest first. Ties broken by geohash so the order is stable.
async function heatCells(qloo, artist_id, city, prov) {
  const body = await insightsOrEmpty(qloo, { "filter.type": "urn:heatmap", "signal.interests.entities": artist_id, "filter.location.query": city, take: 50 }, prov);
  return listOf(body, "heatmap")
    .map((c) => ({ lat: c?.location?.latitude, lon: c?.location?.longitude, geohash: c?.location?.geohash, affinity: affOf(c) ?? 0 }))
    .filter((c) => c.geohash && typeof c.lat === "number")
    .sort((a, b) => b.affinity - a.affinity || a.geohash.localeCompare(b.geohash));
}

// 3. Where in the city are this artist's fans? Uses the artist's own map if it has >= MIN_CELLS areas,
//    otherwise the first similar artist (max MAX_CANDIDATES) that does. Always says which one it used.
export async function fanMap(qloo, { artist_id, artist_name, city }) {
  checkId(artist_id);
  city = checkCity(city);
  const prov = [];
  const own = await heatCells(qloo, artist_id, city, prov);
  const tried = [{ name: artist_name ?? "this artist", cells: own.length }];
  if (own.length >= MIN_CELLS) {
    return { ...envelope("ok", `Using ${artist_name ?? "the artist"}'s own fan data in ${city} (${areas(own.length)}).`, own.slice(0, MAP_CELLS), prov), source: "artist", proxy: null, tried, area_count: own.length };
  }
  const sim = await similarArtists(qloo, { artist_id, take: 20 });
  prov.push(...sim.provenance);
  for (const cand of sim.results.slice(0, MAX_CANDIDATES)) {
    const cells = await heatCells(qloo, cand.artist_id, city, prov);
    tried.push({ name: cand.name, cells: cells.length });
    if (cells.length >= MIN_CELLS) {
      return {
        ...envelope("ok", `${artist_name ?? "This artist"} has ${areas(own.length)} of fan data in ${city}, so this map uses ${cand.name}, the closest similar artist with enough data (${areas(cells.length)}). Proxy data, not the artist's own.`, cells.slice(0, MAP_CELLS), prov),
        source: "proxy", proxy: { artist_id: cand.artist_id, name: cand.name, overlap_affinity: cand.affinity }, tried, area_count: cells.length,
      };
    }
  }
  return { ...envelope("empty", `No artist close to ${artist_name ?? "this one"} has enough fan data in ${city}. No map.`, [], prov), source: "none", proxy: null, tried, area_count: 0 };
}

// 4. Places in the city that match the artist's fans. Flags places Qloo marks as having live music or event space.
export async function fanPlaces(qloo, { artist_id, city, take = 10 }) {
  checkId(artist_id);
  city = checkCity(city);
  const prov = [];
  const body = await insightsOrEmpty(qloo, { "filter.type": "urn:entity:place", "signal.interests.entities": artist_id, "filter.location.query": city, take: Math.min(Number(take) || 10, 25) }, prov);
  const results = listOf(body, "entities").map((e) => {
    const p = e?.properties ?? {};
    return {
      place_id: idOf(e), name: e?.name, affinity: affOf(e),
      lat: e?.location?.lat ?? null, lon: e?.location?.lon ?? null,
      address: p.address ?? null, neighborhood: p.neighborhood ?? null,
      // primary_genre is a tag object, e.g. { id: "urn:tag:genre:place:restaurant:west_african", name: "West African restaurant" }.
      kind: p.primary_genre?.name ?? null,
      live_music: Boolean(p.live_music), event_space: Boolean(p.event_spaces),
    };
  });
  return envelope(results.length ? "ok" : "empty", results.length ? `${results.length} places in ${city} match this artist's fans; ${results.filter((r) => r.live_music || r.event_space).length} have live music or event space.` : `Qloo has no matching places in ${city}.`, results, prov);
}

// 5. Opening-act ideas: artists who share fans, and the Afrobeats artists most distinctive to this city.
//    Two separate lists with separate sources — the UI must not merge them into one claim.
//    Artists Qloo marks with an end_year go to a third list, "not_active", and are never suggested.
export async function openingActs(qloo, { artist_id, city }) {
  checkId(artist_id);
  city = checkCity(city);
  const prov = [];
  const sim = await similarArtists(qloo, { artist_id, take: 10 });
  prov.push(...sim.provenance);
  const body = await insightsOrEmpty(qloo, { "filter.type": "urn:entity:artist", "signal.location.query": city, "filter.tags": AFROBEATS_TAG, take: 10 }, prov);
  const local = listOf(body, "entities").filter((e) => idOf(e) !== artist_id).map(artistRow);
  const tag = (list) => (a) => ({ ...a, list: a.end_year ? "not_active" : list });
  const results = [...sim.results.map(tag("shared_fans")), ...local.map(tag("local_scene"))];
  const count = (list) => results.filter((a) => a.list === list).length;
  const gone = results.filter((a) => a.list === "not_active");
  return envelope(results.length ? "ok" : "empty",
    `${count("shared_fans")} active artists share fans; ${count("local_scene")} Afrobeats artists are distinctive to ${city}'s audience.` +
    (gone.length ? ` Left out because Qloo says they stopped performing: ${gone.map((a) => `${a.name} (${a.end_year})`).join(", ")}.` : ""),
    results, prov);
}

export const TOOLS = {
  resolve_artist: resolveArtist,
  similar_artists: similarArtists,
  fan_map: fanMap,
  fan_places: fanPlaces,
  opening_acts: openingActs,
};
