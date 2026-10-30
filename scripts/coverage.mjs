// Qloo coverage test: does the hackathon API know Nigerian music, film, books and places?
// Each Nigerian item runs next to a well-known control item. The API silently ignores bad
// parameters, so an empty Nigerian result only means "missing data" if its control has results.
//
// Usage (PowerShell):  $env:QLOO_API_KEY="..."   then   node scripts/coverage.mjs
// No key set -> dry run: prints the planned requests and calls nothing.
//
// Output goes to results/ (git-ignored). Never commit Qloo response data: the repo is public.

import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://hackathon.api.qloo.com";
const KEY = process.env.QLOO_API_KEY;
const DRY = !KEY;
const DELAY_MS = 300;
const TIMEOUT_MS = 20000; // one try per request, no retries

// [group, name] pairs per type. "ng" = Nigerian, "ctl" = control.
// Search types and insights filter.type differ for some categories, so both are listed.
const CATALOG = [
  { label: "artist", search: "urn:entity:artist", insights: "urn:entity:artist", items: [
    ["ng", "Burna Boy"], ["ng", "Wizkid"], ["ng", "Tems"], ["ng", "Asake"], ["ng", "Fela Kuti"],
    ["ng", "Flavour"], ["ng", "Phyno"], ["ng", "Olamide"],
    ["ctl", "Taylor Swift"], ["ctl", "Kendrick Lamar"], ["ctl", "Bad Bunny"],
  ]},
  { label: "movie", search: "urn:entity:movie", insights: "urn:entity:movie", items: [
    ["ng", "The Wedding Party"], ["ng", "King of Boys"], ["ng", "Lionheart"], ["ng", "Anikulapo"],
    ["ng", "Gangs of Lagos"], ["ng", "A Tribe Called Judah"], ["ng", "Living in Bondage: Breaking Free"],
    ["ctl", "The Godfather"], ["ctl", "Barbie"],
  ]},
  { label: "tv_show", search: "urn:entity:tv_show", insights: "urn:entity:tv_show", items: [
    ["ng", "Blood Sisters"], ["ng", "Shanty Town"],
    ["ctl", "Breaking Bad"],
  ]},
  { label: "book", search: "urn:entity:book", insights: "urn:entity:book", items: [
    ["ng", "Things Fall Apart"], ["ng", "Half of a Yellow Sun"], ["ng", "Americanah"],
    ["ctl", "The Great Gatsby"],
  ]},
  { label: "brand", search: "urn:entity:brand", insights: "urn:entity:brand", items: [
    ["ng", "Jumia"], ["ng", "Indomie"], ["ng", "Chi Limited"],
    ["ctl", "Coca-Cola"],
  ]},
];

// Cities for the "places near here" check (filter.location.query on /v2/insights).
const CITIES = [
  ["ng", "Lagos"], ["ng", "Abuja"], ["ng", "Enugu"], ["ng", "Port Harcourt"],
  ["ctl", "Austin"], ["ctl", "London"],
];

// Cross-domain check: for each Nigerian artist found, what movies do their fans like?
const CROSS_TYPE = "urn:entity:movie";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
// Same fallback the official @qloo/qloo-harness 0.1.26 uses: scalar(entity, "entity_id", "id").
const idOf = (e) => e?.entity_id ?? e?.id ?? null;
const raw = [];

async function get(path, params) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  if (DRY) { console.log("DRY GET", url); return null; }
  await sleep(DELAY_MS);
  const label = `${path} ${params.query ?? params["filter.location.query"] ?? params["signal.interests.entities"] ?? ""}`;
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
  if (!res.ok) console.warn(`  ${res.status} on ${url}: ${text.slice(0, 200)}`);
  return res.ok ? body : null;
}

// Search returns a list; take the first result whose name matches the query.
function pickMatch(results, name) {
  const want = norm(name);
  return (results ?? []).slice(0, 5).find((r) => {
    const got = norm(r?.name);
    return got === want || got.includes(want) || want.includes(got);
  }) ?? null;
}

// Status of the most recent call: "200", "400", "timeout_or_network"...
const lastStatus = () => String(raw.at(-1)?.status ?? "");

const insightNames = (body) => (body?.results?.entities ?? []).map((e) => e?.name).filter(Boolean);

async function main() {
  console.log(DRY ? "No QLOO_API_KEY set: dry run, no calls made.\n" : "Running against " + BASE + "\n");
  const rows = [];

  for (const cat of CATALOG) {
    for (const [group, name] of cat.items) {
      const body = await get("/search", { query: name, types: cat.search, take: "5" });
      const hit = pickMatch(body?.results, name);
      const row = { type: cat.label, group, name, found: !!hit, matched: hit?.name ?? "", popularity: hit?.popularity ?? "",
        topResult: body?.results?.[0]?.name ?? "", id: idOf(hit), similar: [], insights: "" };
      if (hit && row.id) {
        const ins = await get("/v2/insights", { "filter.type": cat.insights, "signal.interests.entities": row.id, take: "10" });
        row.similar = insightNames(ins);
        row.insights = lastStatus() === "400" ? "ID rejected" : lastStatus();
      }
      rows.push(row);
    }
  }

  const cross = [];
  for (const r of rows.filter((r) => r.type === "artist" && r.id)) {
    const ins = await get("/v2/insights", { "filter.type": CROSS_TYPE, "signal.interests.entities": r.id, take: "10" });
    cross.push({ group: r.group, artist: r.name, movies: insightNames(ins), status: lastStatus() });
  }

  const cities = [];
  for (const [group, city] of CITIES) {
    const ins = await get("/v2/insights", { "filter.type": "urn:entity:place", "filter.location.query": city, take: "50" });
    const names = insightNames(ins);
    cities.push({ group, city, count: names.length, sample: names.slice(0, 8) });
  }

  if (DRY) return;

  // ---- Report ----
  const pct = (g) => { const xs = rows.filter((r) => r.group === g); return `${xs.filter((r) => r.found).length}/${xs.length}`; };
  const L = [];
  L.push(`# Qloo coverage test — ${new Date().toISOString()}`, "");
  L.push(`Found by search: Nigerian ${pct("ng")}, control ${pct("ctl")}.`);
  L.push(`Found but ID rejected by insights: ${rows.filter((r) => r.insights === "ID rejected").map((r) => r.name).join(", ") || "none"}.`, "");
  L.push("## Search and similar items", "", "| type | group | name | found | matched as | popularity | insights | similar (count) |", "|---|---|---|---|---|---|---|---|");
  for (const r of rows) L.push(`| ${r.type} | ${r.group} | ${r.name} | ${r.found ? "yes" : "NO"} | ${r.matched || (r.topResult ? `(top: ${r.topResult})` : "")} | ${r.popularity} | ${r.insights} | ${r.similar.length} |`);
  L.push("", "## Similar items (read these by eye: are Nigerian items near other Nigerian items?)", "");
  for (const r of rows.filter((r) => r.similar.length)) L.push(`- **${r.name}** (${r.group}): ${r.similar.join(", ")}`);
  L.push("", "## Cross-domain: movies liked by fans of each artist", "");
  for (const c of cross) L.push(`- **${c.artist}** (${c.group}): ${c.movies.join(", ") || `(none, status ${c.status})`}`);
  L.push("", "## Places by city (take=50)", "", "| group | city | places | sample |", "|---|---|---|---|");
  for (const c of cities) L.push(`| ${c.group} | ${c.city} | ${c.count} | ${c.sample.join(", ")} |`);

  mkdirSync("results", { recursive: true });
  writeFileSync(`results/summary-${STAMP}.md`, L.join("\n") + "\n");
  console.log(L.join("\n"));
  saveRaw();
  console.log(`Saved results/summary-${STAMP}.md`);
}

// Raw answers are saved on success, on error and on Ctrl+C, so a stopped run still leaves evidence.
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
function saveRaw() {
  if (DRY || !raw.length) return;
  mkdirSync("results", { recursive: true });
  writeFileSync(`results/raw-${STAMP}.json`, JSON.stringify(raw, null, 2));
  console.log(`\nSaved results/raw-${STAMP}.json (${raw.length} calls).`);
}
process.on("SIGINT", () => { saveRaw(); process.exit(130); });

main().catch((e) => { console.error(e.message); saveRaw(); process.exit(1); });
