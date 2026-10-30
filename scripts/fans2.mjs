// Follow-up to fans.mjs. fans.mjs Test A was inconclusive: asking Qloo to score 8 named artists for a city
// returned nothing for most cities, even for Taylor Swift. This script asks the questions another way.
//
// Part 1 (heatmap): do BIGGER Nigerian artists (Burna Boy, Wizkid, Tems) have neighbourhood data abroad?
//   fans.mjs showed Phyno has none (1 empty cell) while Taylor Swift has thousands.
// Part 2 (open city ranking): ask "top 50 artists for this city's audience" with no list of names,
//   once with no genre filter and once filtered to the Afrobeats tag. Where do our artists land?
//
// Pass rules, set BEFORE the run (written into the report):
//   Control check: Taylor Swift must be in the plain top 50 for at least 2 of London, New York City,
//     Los Angeles. If not, Part 2 does not work as asked and its results mean nothing.
//   Rule H: at least 2 of the 3 artists have >= 50 heatmap cells in at least 2 of the 3 cities.
//   Rule C: the Afrobeats-filtered ranking returns results in >= 6 of the 10 cities outside Africa,
//     AND at least one of our 6 Nigerian artists is in that list in >= 5 of those 10 cities.
//
// Usage (PowerShell):  $env:QLOO_API_KEY="..."   then   node scripts/fans2.mjs
// No key set -> dry run. Output goes to results/ (git-ignored). Never commit Qloo data.

import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://hackathon.api.qloo.com";
const KEY = process.env.QLOO_API_KEY;
const DRY = !KEY;
const DELAY_MS = 300;
const TIMEOUT_MS = 20000; // one try per request, no retries

const HEAT_ARTISTS = ["Burna Boy", "Wizkid", "Tems"];
const HEAT_CITIES = ["London", "Houston", "Toronto"];
const NG_ARTISTS = ["Burna Boy", "Wizkid", "Asake", "Phyno", "Flavour", "Tems"];
const AFRICA = ["Lagos", "Accra", "Johannesburg"];
const ABROAD = ["London", "Manchester", "Dublin", "Paris", "Houston", "Atlanta", "New York City", "Toronto", "Los Angeles", "Tokyo"];
const CONTROL_CITIES = ["London", "New York City", "Los Angeles"];
const TAG_QUERY = "afrobeats";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
// Same fallbacks the official @qloo/qloo-harness 0.1.26 uses.
const idOf = (e) => e?.entity_id ?? e?.id ?? null;
const tagIdOf = (t) => t?.id ?? t?.tag_id ?? null;
const affOf = (e) => e?.query?.affinity ?? e?.affinity ?? null;
const listOf = (body, key) => (Array.isArray(body?.results) ? body.results : body?.results?.[key] ?? []);
const raw = [];

async function get(path, params) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  if (DRY) { console.log("DRY GET", url); return null; }
  await sleep(DELAY_MS);
  const label = `${path} ${params.query ?? params["filter.query"] ?? params["signal.location.query"] ?? params["filter.location.query"] ?? ""}`;
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

async function resolveArtist(name) {
  if (DRY) return `<${name}>`;
  const body = await get("/search", { query: name, types: "urn:entity:artist", take: "5" });
  const results = listOf(body, "entities");
  const hit = results.find((r) => norm(r?.name) === norm(name)) ?? results[0];
  return idOf(hit);
}

const fmt = (x) => (typeof x === "number" ? x.toFixed(3) : "—");

async function main() {
  console.log(DRY ? "No QLOO_API_KEY set: dry run, no calls made.\n" : "Running against " + BASE + "\n");

  // ---- Part 1: heatmaps ----
  const heat = [];
  for (const name of HEAT_ARTISTS) {
    const id = await resolveArtist(name);
    for (const city of HEAT_CITIES) {
      if (!id) { heat.push({ name, city, cells: 0, top: null, note: "artist not found" }); continue; }
      const body = await get("/v2/insights", {
        "filter.type": "urn:heatmap", "signal.interests.entities": id, "filter.location.query": city, take: "50",
      });
      const cells = listOf(body, "heatmap");
      const top = Math.max(...cells.map((c) => affOf(c) ?? -1), -1);
      heat.push({ name, city, cells: cells.length, top: top >= 0 ? top : null });
    }
  }

  // ---- Part 2: open city ranking, plain and Afrobeats-filtered ----
  const tagBody = await get("/v2/tags", { "filter.query": TAG_QUERY, "feature.semantic_search": "true", take: "10" });
  const tags = listOf(tagBody, "tags");
  // Prefer an exact "Afrobeats" name; print all candidates so the choice can be checked by eye.
  const tag = tags.find((t) => norm(t?.name) === norm(TAG_QUERY)) ?? tags[0];
  const tagId = DRY ? "<afrobeats-tag-id>" : tagIdOf(tag);

  const plain = {}; const afro = {};
  for (const city of [...AFRICA, ...ABROAD]) {
    const p = await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.location.query": city, take: "50" });
    plain[city] = listOf(p, "entities").map((e) => e?.name).filter(Boolean);
    if (tagId) {
      const a = await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.location.query": city, "filter.tags": tagId, take: "50" });
      afro[city] = listOf(a, "entities").map((e) => e?.name).filter(Boolean);
    } else afro[city] = [];
  }

  if (DRY) return;

  // ---- Rules ----
  const inList = (list, artist) => list.findIndex((n) => norm(n) === norm(artist));
  const controlHits = CONTROL_CITIES.filter((c) => inList(plain[c], "Taylor Swift") >= 0);
  const controlOk = controlHits.length >= 2;
  const heatArtistsOk = HEAT_ARTISTS.filter((n) => heat.filter((h) => h.name === n && h.cells >= 50).length >= 2);
  const ruleH = heatArtistsOk.length >= 2;
  const abroadNonAfrica = ABROAD;
  const afroNonEmpty = abroadNonAfrica.filter((c) => afro[c].length > 0);
  const ngSpread = NG_ARTISTS.map((n) => ({ n, cities: abroadNonAfrica.filter((c) => inList(afro[c], n) >= 0).length }));
  const ruleC = afroNonEmpty.length >= 6 && ngSpread.some((x) => x.cities >= 5);

  // ---- Report ----
  const L = [];
  L.push(`# Qloo fan-location follow-up — ${new Date().toISOString()}`, "");
  L.push(`**Control check** (Taylor Swift in plain top 50 for >=2 of ${CONTROL_CITIES.join(", ")}): ${controlOk ? "OK" : "FAILED — Part 2 results mean nothing"} — found in ${controlHits.join(", ") || "none"}`);
  L.push(`**Rule H** (>=2 of 3 artists with >=50 heatmap cells in >=2 of 3 cities): ${ruleH ? "PASS" : "FAIL"} — ${heatArtistsOk.join(", ") || "none"}`);
  L.push(`**Rule C** (Afrobeats ranking non-empty in >=6/10 cities abroad AND one Nigerian artist in >=5): ${!controlOk ? "NOT VALID (control failed)" : ruleC ? "PASS" : "FAIL"} — non-empty in ${afroNonEmpty.length}/10; best spread ${Math.max(...ngSpread.map((x) => x.cities))}`, "");
  L.push("## Part 1: heatmaps", "", "| artist | city | cells | top affinity |", "|---|---|---|---|");
  for (const h of heat) L.push(`| ${h.name} | ${h.city} | ${h.cells} | ${fmt(h.top)} ${h.note ?? ""} |`);
  L.push("", `## Afrobeats tag used: ${tag?.name ?? "NONE"} (${tagId ?? "-"})`, "");
  L.push(`Candidates: ${tags.map((t) => `${t?.name} [${tagIdOf(t)}]`).join("; ") || "none"}`, "");
  L.push("## Part 2: where our Nigerian artists rank (position in top 50; — = not in list)", "");
  const cities = [...AFRICA, ...ABROAD];
  L.push(`| artist | list | ${cities.join(" | ")} |`, `|---|---|${cities.map(() => "---").join("|")}|`);
  for (const n of [...NG_ARTISTS, "Taylor Swift"]) {
    L.push(`| ${n} | plain | ${cities.map((c) => { const i = inList(plain[c], n); return i >= 0 ? i + 1 : "—"; }).join(" | ")} |`);
    L.push(`| ${n} | afrobeats | ${cities.map((c) => { const i = inList(afro[c], n); return i >= 0 ? i + 1 : "—"; }).join(" | ")} |`);
  }
  L.push("", "## Afrobeats top 5 by city (do cities differ?)", "");
  for (const c of cities) L.push(`- **${c}** (${afro[c].length}): ${afro[c].slice(0, 5).join(", ") || "none"}`);
  L.push("", "## Plain top 5 by city", "");
  for (const c of cities) L.push(`- **${c}** (${plain[c].length}): ${plain[c].slice(0, 5).join(", ") || "none"}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync("results", { recursive: true });
  writeFileSync(`results/fans2-summary-${stamp}.md`, L.join("\n") + "\n");
  writeFileSync(`results/fans2-raw-${stamp}.json`, JSON.stringify(raw, null, 2));
  console.log("\n" + L.join("\n"));
  console.log(`\nSaved results/fans2-summary-${stamp}.md and results/fans2-raw-${stamp}.json (${raw.length} calls).`);
}

main().catch((e) => {
  console.error(e.message);
  if (raw.length) {
    mkdirSync("results", { recursive: true });
    writeFileSync(`results/fans2-raw-partial-${Date.now()}.json`, JSON.stringify(raw, null, 2));
    console.error("Saved partial raw answers in results/.");
  }
  process.exit(1);
});
