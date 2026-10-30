// Proxy test for PLAN.md: can a similar BIG artist's heatmap stand in for an artist with no data?
//
// For a target artist who HAS data (Tems, Wizkid), pretend they do not:
//   1. Get the target's own heatmap in the city (the truth).
//   2. Ask Qloo for artists similar to the target, in Qloo's order.
//   3. The proxy is the first similar artist with >= MIN_CELLS heatmap areas in that city (max 8 tried).
//   4. Compare the proxy's top 10 areas with the target's own top 30 areas.
//
// Pass rule, set BEFORE the run (same as PLAN.md):
//   London: at least 5 of the proxy's top 10 areas are in the target's own top 30, for Tems AND Wizkid.
// Validity check (added before the run): Taylor Swift's top 10 must overlap the target's top 30 LESS than
//   the proxy does, and in fewer than 5 areas. If Taylor Swift scores as well as the proxy, the heatmap
//   is mostly "where people live" and the proxy test proves nothing.
// Houston and Toronto are reported as extra information, not part of the rule.
//
// Usage (PowerShell):  $env:QLOO_API_KEY="..."   then   node scripts/proxy.mjs
// No key set -> dry run. Output goes to results/ (git-ignored). Never commit Qloo data.

import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://hackathon.api.qloo.com";
const KEY = process.env.QLOO_API_KEY;
const DRY = !KEY;
const DELAY_MS = 300;
const TIMEOUT_MS = 20000; // one try per request, no retries

const TARGETS = ["Tems", "Wizkid"];
const CONTROL = "Taylor Swift";
const CITIES = ["London", "Houston", "Toronto"];
const RULE_CITY = "London";
const MIN_CELLS = 200;
const MAX_CANDIDATES = 8;
const PROXY_TOP = 10;
const OWN_TOP = 30;
const PASS_OVERLAP = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
// Same fallbacks the official @qloo/qloo-harness 0.1.26 uses.
const idOf = (e) => e?.entity_id ?? e?.id ?? null;
const affOf = (e) => e?.query?.affinity ?? e?.affinity ?? null;
const listOf = (body, key) => (Array.isArray(body?.results) ? body.results : body?.results?.[key] ?? []);
const geoOf = (c) => c?.location?.geohash ?? c?.geohash ?? null;
const raw = [];

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

// Heatmap areas sorted by affinity (high first). Ties are common (many 1.000), so break them by
// geohash to keep the order the same on every run.
async function heatmap(id, city) {
  const body = await get("/v2/insights", {
    "filter.type": "urn:heatmap", "signal.interests.entities": id, "filter.location.query": city, take: "50",
  });
  return listOf(body, "heatmap")
    .map((c) => ({ geo: geoOf(c), aff: affOf(c) ?? 0 }))
    .filter((c) => c.geo)
    .sort((a, b) => b.aff - a.aff || a.geo.localeCompare(b.geo));
}

const topSet = (cells, n) => new Set(cells.slice(0, n).map((c) => c.geo));
const overlap = (cells, ownTop) => cells.slice(0, PROXY_TOP).filter((c) => ownTop.has(c.geo)).length;
// Looser match: same 5-character geohash prefix (about 5 km square).
const overlap5 = (cells, ownCells) => {
  const own5 = new Set(ownCells.slice(0, OWN_TOP).map((c) => c.geo.slice(0, 5)));
  return cells.slice(0, PROXY_TOP).filter((c) => own5.has(c.geo.slice(0, 5))).length;
};
const tiesAtTop = (cells) => cells.filter((c) => c.aff === cells[0]?.aff).length;

async function main() {
  console.log(DRY ? "No QLOO_API_KEY set: dry run, no calls made.\n" : "Running against " + BASE + "\n");
  const control = await resolveArtist(CONTROL);
  const rows = [];

  for (const targetName of TARGETS) {
    const target = await resolveArtist(targetName);
    if (!target.id) { rows.push({ target: targetName, error: "not found" }); continue; }
    const simBody = await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": target.id, take: "20" });
    const similar = listOf(simBody, "entities").filter((e) => idOf(e) && idOf(e) !== target.id);
    const candidates = DRY ? [{ name: "<similar artist>", entity_id: "<similar-id>" }] : similar.slice(0, MAX_CANDIDATES);

    for (const city of CITIES) {
      const own = await heatmap(target.id, city);
      const ownTop = topSet(own, OWN_TOP);
      let proxy = null; const tried = [];
      for (const c of candidates) {
        const cells = await heatmap(idOf(c), city);
        tried.push(`${c.name} (${cells.length})`);
        if (cells.length >= MIN_CELLS) { proxy = { name: c.name, cells }; break; }
      }
      const ctl = control.id ? await heatmap(control.id, city) : [];
      rows.push({
        target: target.name, city, ownCells: own.length, ownTies: tiesAtTop(own), tried,
        proxy: proxy?.name ?? null, proxyCells: proxy?.cells.length ?? 0,
        proxyOverlap: proxy ? overlap(proxy.cells, ownTop) : null,
        proxyOverlap5: proxy ? overlap5(proxy.cells, own) : null,
        ctlCells: ctl.length, ctlOverlap: overlap(ctl, ownTop), ctlOverlap5: overlap5(ctl, own),
      });
    }
  }

  if (DRY) return;

  // ---- Rule ----
  const ruleRows = rows.filter((r) => r.city === RULE_CITY);
  const passEach = ruleRows.map((r) => ({
    target: r.target,
    pass: r.proxyOverlap !== null && r.proxyOverlap >= PASS_OVERLAP,
    valid: r.proxyOverlap !== null && r.ctlOverlap < r.proxyOverlap && r.ctlOverlap < PASS_OVERLAP,
  }));
  const allValid = passEach.length === TARGETS.length && passEach.every((p) => p.valid);
  const allPass = passEach.length === TARGETS.length && passEach.every((p) => p.pass);

  // ---- Report ----
  const L = [];
  L.push(`# Qloo proxy test — ${new Date().toISOString()}`, "");
  L.push(`**Rule** (${RULE_CITY}: proxy top ${PROXY_TOP} has >= ${PASS_OVERLAP} areas in target's own top ${OWN_TOP}, for ${TARGETS.join(" and ")}): ${allPass ? "PASS" : "FAIL"}`);
  L.push(`**Validity** (${CONTROL} overlaps less than the proxy, and < ${PASS_OVERLAP}): ${allValid ? "OK" : "FAILED — the heatmap may only show where people live"}`);
  L.push(`**Verdict:** ${allPass && allValid ? "proxy map is usable — keep the map in the product" : "proxy map NOT shown to work — drop the map, keep places + opening act"}`, "");
  L.push(`Exact match = same heatmap area. Loose match = same 5-character geohash (about 5 km).`, "");
  L.push("| target | city | own areas | ties at top | proxy (areas) | proxy overlap exact / loose | control areas | control overlap exact / loose | candidates tried (areas) |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    if (r.error) { L.push(`| ${r.target} | — | ${r.error} |||||||`); continue; }
    L.push(`| ${r.target} | ${r.city} | ${r.ownCells} | ${r.ownTies} | ${r.proxy ?? "NONE"} (${r.proxyCells}) | ${r.proxyOverlap ?? "—"} / ${r.proxyOverlap5 ?? "—"} | ${r.ctlCells} | ${r.ctlOverlap} / ${r.ctlOverlap5} | ${r.tried.join(", ")} |`);
  }
  L.push("", `Note: if "ties at top" is large (for example over ${OWN_TOP}), the top-${OWN_TOP} list is partly arbitrary, and the exact overlap is less reliable than the loose one.`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync("results", { recursive: true });
  writeFileSync(`results/proxy-summary-${stamp}.md`, L.join("\n") + "\n");
  writeFileSync(`results/proxy-raw-${stamp}.json`, JSON.stringify(raw, null, 2));
  console.log("\n" + L.join("\n"));
  console.log(`\nSaved results/proxy-summary-${stamp}.md and results/proxy-raw-${stamp}.json (${raw.length} calls).`);
}

main().catch((e) => {
  console.error(e.message);
  if (raw.length) {
    mkdirSync("results", { recursive: true });
    writeFileSync(`results/proxy-raw-partial-${Date.now()}.json`, JSON.stringify(raw, null, 2));
    console.error("Saved partial raw answers in results/.");
  }
  process.exit(1);
});
