// Tour Planner page. Talks only to this Worker's /api; never to Qloo or Claude directly.
// All API text goes into the page with textContent, never innerHTML.
"use strict";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
const SOURCE_LABEL = { artist_data: "Artist data (Qloo)", proxy_data: "Proxy data (Qloo, similar artist)", ai_summary: "AI summary of the data" };

let map, layers;
let lastName = ""; // the name of the artist this plan is for (the chosen candidate, if the user picked one)

// ---- Geohash -> bounding box, to draw each fan area as the real cell Qloo scored ----
const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";
function geohashBounds(hash) {
  let even = true, lat = [-90, 90], lon = [-180, 180];
  for (const ch of hash) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    for (let bit = 4; bit >= 0; bit--) {
      const r = even ? lon : lat;
      const mid = (r[0] + r[1]) / 2;
      if ((v >> bit) & 1) r[0] = mid; else r[1] = mid;
      even = !even;
    }
  }
  return [[lat[0], lon[0]], [lat[1], lon[1]]];
}

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;

function ensureMap() {
  if (map) return;
  map = L.map("map", { scrollWheelZoom: false });
  // Standard OpenStreetMap tiles (no key). Dark mode darkens them with a CSS filter in style.css.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  layers = L.layerGroup().addTo(map);
}

// Call only when #map is visible: Leaflet needs the real container size to fit the bounds.
function drawMap(fanMap, places) {
  ensureMap();
  map.invalidateSize();
  layers.clearLayers();
  const bounds = [];
  const cells = fanMap?.results ?? [];
  const max = Math.max(...cells.map((c) => c.affinity), 0.0001);
  for (const c of cells) {
    const b = geohashBounds(c.geohash);
    if (!b) continue;
    L.rectangle(b, { stroke: false, fillColor: css("--area"), fillOpacity: 0.12 + 0.5 * (c.affinity / max), interactive: false }).addTo(layers);
    bounds.push(b[0], b[1]);
  }
  for (const p of places?.results ?? []) {
    if (typeof p.lat !== "number" || typeof p.lon !== "number") continue;
    const hot = p.live_music || p.event_space;
    const m = L.circleMarker([p.lat, p.lon], { radius: hot ? 8 : 6, color: "#fff", weight: 1.5, fillColor: hot ? css("--warm") : css("--place"), fillOpacity: 0.95 }).addTo(layers);
    const flags = [p.live_music && "live music", p.event_space && "event space"].filter(Boolean).join(", ") || "no live music or event space listed";
    const pop = el("div", {}, el("strong", { textContent: p.name }), el("br"), document.createTextNode([p.kind, p.neighborhood].filter(Boolean).join(" · ")), el("br"), document.createTextNode(flags));
    m.bindPopup(pop);
    bounds.push([p.lat, p.lon]);
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [20, 20], maxZoom: 14 });
  else map.setView([51.5, -0.12], 10);
}

function show(id, on = true) { $(id).hidden = !on; }
function setStatus(text, isError = false) {
  const s = $("status");
  s.textContent = text;
  s.className = "status" + (isError ? " error" : "");
  show("status", Boolean(text));
}

function renderPlan(r) {
  const plan = r.plan;
  show("result"); // before drawMap, so the map container has a size
  $("r-meta").textContent = `${r.data?.resolve_artist?.results?.[0]?.name ?? lastName} · ${r.city}${r.cached ? " · saved plan" : ""}`;
  $("r-headline").textContent = plan.headline;

  const fm = r.data?.fan_map;
  $("map-note").textContent = !fm ? "No map data."
    : fm.source === "proxy" ? `This artist has too little fan data here, so the map uses ${fm.proxy?.name} (${fm.area_count} areas), the closest similar artist with enough data. It shows where fans of this kind of music cluster.`
    : fm.source === "artist" ? `This artist's own Qloo fan data (${fm.area_count} areas).`
    : "No similar artist has enough fan data in this city, so there is no map. Places are still shown.";
  drawMap(fm, r.data?.fan_places);

  const secs = $("sections");
  secs.replaceChildren(...plan.sections.map((s) =>
    el("div", { className: "card section" },
      el("span", { className: `badge ${s.source}`, textContent: SOURCE_LABEL[s.source] ?? s.source }),
      el("h3", { textContent: s.title }),
      el("p", { textContent: s.text }))));

  const acts = r.data?.opening_acts?.results ?? [];
  const li = (a) => el("li", { textContent: a.name });
  $("acts-shared").replaceChildren(...acts.filter((a) => a.list === "shared_fans").map(li));
  $("acts-local").replaceChildren(...acts.filter((a) => a.list === "local_scene").map(li));
  const gone = acts.filter((a) => a.list === "not_active");
  $("acts-gone").textContent = gone.length ? `Left out because Qloo says they stopped performing: ${gone.map((a) => `${a.name} (${a.end_year})`).join(", ")}.` : "";
  show("acts-gone", gone.length > 0);

  $("caveats").replaceChildren(...plan.caveats.map((c) => el("li", { textContent: c })));
  const prov = Object.fromEntries(Object.entries(r.data ?? {}).map(([k, v]) => [k, v?.provenance ?? []]));
  $("prov").textContent = JSON.stringify(prov, null, 2);
}

function renderChoices(r, city) {
  $("choose-msg").textContent = r.status === "empty" ? "Qloo found no artist with that name. Check the spelling." : "Several artists match that name. Pick one.";
  $("choices").replaceChildren(...(r.candidates ?? []).map((c) => {
    const b = el("button", { type: "button" }, el("strong", { textContent: c.name }), document.createTextNode(c.description && c.description !== c.name ? c.description : ""));
    b.addEventListener("click", () => run({ name: c.name, city, artist_id: c.artist_id }));
    return b;
  }));
  show("choose");
}

async function run(body) {
  lastName = body.name;
  show("result", false); show("choose", false);
  $("go").disabled = true;
  setStatus("Reading Qloo taste data and writing the plan. This takes about 20 seconds.");
  try {
    const res = await fetch("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const r = await res.json().catch(() => ({ status: "error", error: { message: "The server sent an answer that is not JSON." } }));
    if (r.status === "ok") { setStatus(""); renderPlan(r); }
    else if (r.status === "needs_input" || r.status === "empty") { setStatus(""); renderChoices(r, body.city); }
    else setStatus(r.error?.message ?? r.summary ?? "Something went wrong.", true);
  } catch {
    setStatus("Could not reach the server. Check your connection and try again.", true);
  } finally {
    $("go").disabled = false;
  }
}

async function init() {
  try {
    const h = await (await fetch("/api/health")).json();
    $("city").replaceChildren(...h.cities.map((c) => el("option", { value: c, textContent: c })));
    if (!h.configured || !h.agent) setStatus("This demo is not fully configured yet.", true);
  } catch {
    setStatus("Could not reach the server.", true);
  }
  $("plan-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("artist").value.trim();
    if (name) run({ name, city: $("city").value });
  });
}

init();
