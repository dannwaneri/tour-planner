// Small-proxy test. proxy.mjs passed with BIG proxies (Davido, Snoh Aalegra: ~800–1,600 areas).
// In the live Worker, Phyno's proxies are SMALL (Ajebutter22: 234 areas, M.I. Abaga: 216).
// Question: does a proxy with 200–400 areas still match the real map?
//
// For each target artist who HAS data, in each city:
//   - truth   = target's own top 30 areas
//   - small   = first similar artist with SMALL_MIN..SMALL_MAX areas (max 12 similar artists tried)
//   - big     = first similar artist with more than SMALL_MAX areas (for comparison)
//   - control = Taylor Swift
//   overlap = how many of the proxy's top 10 areas are in the truth's top 30 (exact area match).
//
// Pass rule, set BEFORE the run:
//   Valid only if a small proxy is found in >= 4 target-city cases.
//   PASS if, in >= 2/3 of those cases, the small proxy's overlap is >= 5 AND higher than Taylor Swift's.
//   If FAIL: raise MIN_CELLS in src/tools.js to the smallest proxy size that does pass (see the size table),
//   or show "no map" for thin artists.
//
// Usage (PowerShell):  $env:QLOO_API_KEY="..."   then   node scripts/proxy-small.mjs
// No key set -> dry run. Output goes to results/ (git-ignored). Never commit Qloo data.

import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://hackathon.api.qloo.com";
const KEY = process.env.QLOO_API_KEY;
const DRY = !KEY;
const DELAY_MS = 300;
const TIMEOUT_MS = 20000; // one try per request, no retries

const TARGETS = ["Tems", "Wizkid", "Burna Boy", "Davido"];
const CONTROL = "Taylor Swift";
const CITIES = ["London", "Houston", "Toronto"];
const SMALL_MIN = 200;
const SMALL_MAX = 400;
const MAX_CANDIDATES = 12;
const PROXY_TOP = 10;
const OWN_TOP = 30;
const PASS_OVERLAP = 5;
const MIN_CASES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
const idOf = (e) => e?.entity_id ?? e?.id ?? null;
const affOf = (e) => e?.query?.affinity ?? e?.affinity ?? null;
const listOf = (body, key) => (Array.isArray(body?.results) ? body.results : body?.results?.[key] ?? []);
const raw = [];
const memo = new Map(); // same heatmap asked twice in one run -> one call

async function get(path, params) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  if (DRY) { console.log("DRY GET", url); return null; }
  await sleep(DELAY_MS);
  const label = `${path} ${params.query ?? params["filter.location.query"] ?? ""}`;
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
  if (DRY) return { name, id: `<${name}>` };
  const body = await get("/search", { query: name, types: "urn:entity:artist", take: "5" });
  const results = listOf(body, "entities");
  const hit = results.find((r) => norm(r?.name) === norm(name)) ?? results[0];
  return { name: hit?.name ?? name, id: idOf(hit) };
}

async function heatmap(id, city) {
  const k = `${id}|${city}`;
  if (memo.has(k)) return memo.get(k);
  const body = await get("/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": id, "filter.location.query": city, take: "50" });
  const cells = listOf(body, "heatmap")
    .map((c) => ({ geo: c?.location?.geohash ?? null, aff: affOf(c) ?? 0 }))
    .filter((c) => c.geo)
    .sort((a, b) => b.aff - a.aff || a.geo.localeCompare(b.geo));
  memo.set(k, cells);
  return cells;
}

const overlap = (cells, truthTop) => cells.slice(0, PROXY_TOP).filter((c) => truthTop.has(c.geo)).length;

async function main() {
  console.log(DRY ? "No QLOO_API_KEY set: dry run, no calls made.\n" : "Running against " + BASE + "\n");
  const control = await resolveArtist(CONTROL);
  const rows = [];
  const sizePoints = []; // every candidate measured: { size, overlap } — to see where overlap drops

  for (const targetName of TARGETS) {
    const target = await resolveArtist(targetName);
    if (!target.id) { rows.push({ target: targetName, error: "not found" }); continue; }
    const simBody = await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": target.id, take: "20" });
    const similar = DRY ? [{ name: "<similar>", entity_id: "<similar-id>" }]
      : listOf(simBody, "entities").filter((e) => idOf(e) && idOf(e) !== target.id).slice(0, MAX_CANDIDATES);

    for (const city of CITIES) {
      const own = await heatmap(target.id, city);
      if (own.length < OWN_TOP * 2) { rows.push({ target: target.name, city, error: `own map too small (${own.length})` }); continue; }
      const truthTop = new Set(own.slice(0, OWN_TOP).map((c) => c.geo));
      let small = null, big = null;
      for (const s of similar) {
        const cells = await heatmap(idOf(s), city);
        if (cells.length >= SMALL_MIN) sizePoints.push({ size: cells.length, overlap: overlap(cells, truthTop) });
        if (!small && cells.length >= SMALL_MIN && cells.length <= SMALL_MAX) small = { name: s.name, size: cells.length, overlap: overlap(cells, truthTop) };
        if (!big && cells.length > SMALL_MAX) big = { name: s.name, size: cells.length, overlap: overlap(cells, truthTop) };
        if (small && big) break;
      }
      const ctl = control.id ? await heatmap(control.id, city) : [];
      rows.push({ target: target.name, city, ownSize: own.length, small, big, ctlOverlap: overlap(ctl, truthTop) });
    }
  }

  if (DRY) return;

  // ---- Rule ----
  const cases = rows.filter((r) => r.small);
  const passes = cases.filter((r) => r.small.overlap >= PASS_OVERLAP && r.small.overlap > r.ctlOverlap);
  const valid = cases.length >= MIN_CASES;
  const pass = valid && passes.length >= Math.ceil((2 / 3) * cases.length);

  // Overlap by proxy size band, from every candidate measured.
  const bands = [[200, 300], [300, 400], [400, 800], [800, Infinity]].map(([lo, hi]) => {
    const pts = sizePoints.filter((p) => p.size >= lo && p.size < hi);
    const avg = pts.length ? pts.reduce((a, p) => a + p.overlap, 0) / pts.length : null;
    return { band: `${lo}–${hi === Infinity ? "" : hi}`, n: pts.length, avg, atLeast5: pts.filter((p) => p.overlap >= PASS_OVERLAP).length };
  });

  const L = [];
  L.push(`# Qloo small-proxy test — ${new Date().toISOString()}`, "");
  L.push(`**Valid** (small proxy found in >= ${MIN_CASES} cases): ${valid ? "YES" : "NO — inconclusive"} — ${cases.length} cases`);
  L.push(`**Rule** (small proxy overlap >= ${PASS_OVERLAP} and above Taylor Swift in >= 2/3 of cases): ${!valid ? "NOT VALID" : pass ? "PASS" : "FAIL"} — ${passes.length}/${cases.length}`);
  L.push(`**Verdict:** ${!valid ? "not enough small-proxy cases; keep MIN_CELLS and say the small-proxy case is untested" : pass ? `small proxies work — keep MIN_CELLS = ${SMALL_MIN}` : "small proxies do NOT match well — raise MIN_CELLS (see bands) or show no map for thin artists"}`, "");
  L.push("| target | city | own areas | small proxy (areas) → overlap | big proxy (areas) → overlap | Taylor Swift overlap |", "|---|---|---|---|---|---|");
  for (const r of rows) {
    if (r.error) { L.push(`| ${r.target} | ${r.city ?? "—"} | ${r.error} | | | |`); continue; }
    const f = (p) => (p ? `${p.name} (${p.size}) → ${p.overlap}/10` : "none found");
    L.push(`| ${r.target} | ${r.city} | ${r.ownSize} | ${f(r.small)} | ${f(r.big)} | ${r.ctlOverlap}/10 |`);
  }
  L.push("", "## Overlap by proxy size (every similar artist measured)", "", "| areas | candidates | average overlap | with >= 5 |", "|---|---|---|---|");
  for (const b of bands) L.push(`| ${b.band} | ${b.n} | ${b.avg === null ? "—" : b.avg.toFixed(1)} | ${b.atLeast5} |`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync("results", { recursive: true });
  writeFileSync(`results/proxy-small-summary-${stamp}.md`, L.join("\n") + "\n");
  writeFileSync(`results/proxy-small-raw-${stamp}.json`, JSON.stringify(raw, null, 2));
  console.log("\n" + L.join("\n"));
  console.log(`\nSaved results/proxy-small-summary-${stamp}.md and results/proxy-small-raw-${stamp}.json (${raw.length} calls).`);
}

main().catch((e) => {
  console.error(e.message);
  if (raw.length) {
    mkdirSync("results", { recursive: true });
    writeFileSync(`results/proxy-small-raw-partial-${Date.now()}.json`, JSON.stringify(raw, null, 2));
    console.error("Saved partial raw answers in results/.");
  }
  process.exit(1);
});
