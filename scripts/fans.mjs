// Fan-location test for the tour-planner idea: does Qloo know WHERE Nigerian artists' fans are?
//
// Test A (city ranking): for each city, ask Qloo to rank the same 8 artists for that city's audience
//   (filter.results.entities + signal.location.query, the same request qloo_rank builds).
// Test B (heatmap): inside one city, where are an artist's fans? (filter.type=urn:heatmap, as qloo_where_popular).
// Test C (venues): which places in a city match an artist's fans? (filter.type=urn:entity:place).
//
// Pass rule, set BEFORE the run (written into the report):
//   1. For at least 4 of 6 Nigerian artists, affinity in Lagos AND in London is higher than in Tokyo.
//   2. For at least 4 of 6 Nigerian artists, at least 2 of their top-3 cities are not in Taylor Swift's top 3.
//   If either fails, the location signal does not carry real information for these artists, and the
//   tour-planner idea falls back to fan overlap only.
//
// Usage (PowerShell):  $env:QLOO_API_KEY="..."   then   node scripts/fans.mjs
// No key set -> dry run. Output goes to results/ (git-ignored). Never commit Qloo data.

import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://hackathon.api.qloo.com";
const KEY = process.env.QLOO_API_KEY;
const DRY = !KEY;
const DELAY_MS = 300;
const TIMEOUT_MS = 20000; // one try per request, no retries

const ARTISTS = [
  ["ng", "Burna Boy"], ["ng", "Wizkid"], ["ng", "Asake"], ["ng", "Phyno"], ["ng", "Flavour"], ["ng", "Tems"],
  ["ctl", "Taylor Swift"], ["ctl", "Bad Bunny"],
];
// Lagos = should be high for Nigerian artists. Tokyo = should be low. The rest are tour candidates.
const CITIES = ["Lagos", "Accra", "Johannesburg", "London", "Manchester", "Dublin", "Paris",
  "Houston", "Atlanta", "New York City", "Toronto", "Los Angeles", "Tokyo"];
const DEEP_ARTISTS = ["Phyno", "Taylor Swift"];
const DEEP_CITIES = ["London", "Houston", "Toronto"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
// Same fallbacks the official @qloo/qloo-harness 0.1.26 uses.
const idOf = (e) => e?.entity_id ?? e?.id ?? null;
const affOf = (e) => e?.query?.affinity ?? e?.affinity ?? null;
const raw = [];
const lastStatus = () => String(raw.at(-1)?.status ?? "");

async function get(path, params) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  if (DRY) { console.log("DRY GET", url); return null; }
  await sleep(DELAY_MS);
  const label = `${path} ${params.query ?? params["signal.location.query"] ?? params["filter.location.query"] ?? ""}`;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { headers: { "X-Api-Key": KEY }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    console.warn(`  [${raw.length + 1}] ${label}: ${e.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000}s, skipped` : e.message}`);
    raw.push({ url, status: "timeout_or_network", body: null });
    return null;
  }
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  raw.push({ url, status: res.status, body });
  console.log(`  [${raw.length}] ${res.status} ${((Date.now() - t0) / 1000).toFixed(1)}s ${label}`);
  if (res.status === 401) throw new Error("401: key rejected. Check QLOO_API_KEY and that BASE is hackathon.api.qloo.com.");
  if (res.status === 429) throw new Error("429: rate limited. Raise DELAY_MS and run again.");
  if (!res.ok) console.warn(`      ${text.slice(0, 200)}`);
  return res.ok ? body : null;
}

async function resolve(name) {
  const body = await get("/search", { query: name, types: "urn:entity:artist", take: "5" });
  const want = norm(name);
  const hit = (body?.results ?? []).find((r) => norm(r?.name) === want) ?? body?.results?.[0] ?? null;
  return { name, id: idOf(hit), matched: hit?.name ?? "" };
}

const fmt = (x) => (typeof x === "number" ? x.toFixed(3) : "—");

async function main() {
  console.log(DRY ? "No QLOO_API_KEY set: dry run, no calls made.\n" : "Running against " + BASE + "\n");

  // Resolve artist IDs. In dry run, use placeholders so the planned requests still print.
  const artists = [];
  for (const [group, name] of ARTISTS) {
    const r = DRY ? { name, id: `<${name}>`, matched: name } : await resolve(name);
    artists.push({ group, ...r });
  }
  const known = artists.filter((a) => a.id);

  // Test A: affinity of each artist for each city's audience.
  const aff = {}; // aff[artist][city] = number | null
  for (const a of known) aff[a.name] = {};
  const cityStatus = {};
  for (const city of CITIES) {
    const body = await get("/v2/insights", {
      "filter.type": "urn:entity:artist",
      "filter.results.entities": known.map((a) => a.id).join(","),
      "signal.location.query": city,
      take: String(known.length),
    });
    cityStatus[city] = lastStatus();
    for (const e of body?.results?.entities ?? []) {
      const a = known.find((k) => k.id === idOf(e));
      if (a) aff[a.name][city] = affOf(e);
    }
  }

  // Test B + C: inside a few cities, heatmap cells and matching places for one Nigerian artist and one control.
  const deep = [];
  for (const name of DEEP_ARTISTS) {
    const a = known.find((k) => k.name === name);
    if (!a) continue;
    for (const city of DEEP_CITIES) {
      const heat = await get("/v2/insights", {
        "filter.type": "urn:heatmap", "signal.interests.entities": a.id, "filter.location.query": city, take: "20",
      });
      const cells = [...(heat?.results?.heatmap ?? [])].sort((x, y) => (affOf(y) ?? -1) - (affOf(x) ?? -1));
      const places = await get("/v2/insights", {
        "filter.type": "urn:entity:place", "signal.interests.entities": a.id, "filter.location.query": city, take: "10",
      });
      deep.push({ artist: name, city, cells: cells.slice(0, 5), cellCount: cells.length,
        places: (places?.results?.entities ?? []).map((e) => e?.name).filter(Boolean) });
    }
  }

  if (DRY) return;

  // ---- Pass rule ----
  const ng = known.filter((a) => a.group === "ng");
  const beatsTokyo = ng.filter((a) => {
    const t = aff[a.name].Tokyo, l = aff[a.name].Lagos, ln = aff[a.name].London;
    return [t, l, ln].every((v) => typeof v === "number") && l > t && ln > t;
  });
  const topCities = (name) => CITIES.filter((c) => typeof aff[name]?.[c] === "number")
    .sort((x, y) => aff[name][y] - aff[name][x]).slice(0, 3);
  // Compare as sets: at least 2 of the 3 top cities must differ, so a reordering alone does not count.
  const swiftTop = new Set(topCities("Taylor Swift"));
  const differFromSwift = ng.filter((a) => topCities(a.name).filter((c) => !swiftTop.has(c)).length >= 2);
  const rule1 = beatsTokyo.length >= 4;
  const rule2 = differFromSwift.length >= 4;

  // ---- Report ----
  const L = [];
  L.push(`# Qloo fan-location test — ${new Date().toISOString()}`, "");
  L.push(`**Rule 1** (Lagos and London beat Tokyo for >=4 of ${ng.length} Nigerian artists): ${rule1 ? "PASS" : "FAIL"} — ${beatsTokyo.length}/${ng.length} (${beatsTokyo.map((a) => a.name).join(", ") || "none"})`);
  L.push(`**Rule 2** (>=2 of top-3 cities not in Taylor Swift's top 3, for >=4 Nigerian artists): ${rule2 ? "PASS" : "FAIL"} — ${differFromSwift.length}/${ng.length}`);
  L.push(`**Verdict:** ${rule1 && rule2 ? "location signal is usable — tour-planner idea stands" : "location signal NOT shown to be usable — use the fan-overlap backup"}`, "");
  L.push("## Artists resolved", "");
  for (const a of artists) L.push(`- ${a.name} → ${a.matched || "NOT FOUND"} (${a.id ?? "-"})`);
  L.push("", "## Test A: affinity by city (higher = stronger for that city's audience)", "");
  L.push(`| artist | ${CITIES.join(" | ")} | top 3 |`, `|---|${CITIES.map(() => "---").join("|")}|---|`);
  for (const a of known) L.push(`| ${a.name} (${a.group}) | ${CITIES.map((c) => fmt(aff[a.name][c])).join(" | ")} | ${topCities(a.name).join(", ")} |`);
  L.push("", `Request status per city: ${CITIES.map((c) => `${c} ${cityStatus[c]}`).join(", ")}`, "");
  L.push("## Tests B + C: inside a city (heatmap cells and matching places)", "");
  for (const d of deep) {
    L.push(`### ${d.artist} in ${d.city}`);
    L.push(`- heatmap cells: ${d.cellCount}; top: ${d.cells.map((c) => `${JSON.stringify(c.location ?? c.geohash ?? "?")} aff ${fmt(affOf(c))}`).join("; ") || "none"}`);
    L.push(`- places: ${d.places.join(", ") || "none"}`, "");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync("results", { recursive: true });
  writeFileSync(`results/fans-summary-${stamp}.md`, L.join("\n") + "\n");
  writeFileSync(`results/fans-raw-${stamp}.json`, JSON.stringify(raw, null, 2));
  console.log("\n" + L.join("\n"));
  console.log(`\nSaved results/fans-summary-${stamp}.md and results/fans-raw-${stamp}.json (${raw.length} calls).`);
}

main().catch((e) => {
  console.error(e.message);
  if (raw.length) {
    mkdirSync("results", { recursive: true });
    writeFileSync(`results/fans-raw-partial-${Date.now()}.json`, JSON.stringify(raw, null, 2));
    console.error("Saved partial raw answers in results/.");
  }
  process.exit(1);
});
