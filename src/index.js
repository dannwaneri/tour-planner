// Tour planner Worker. Routes:
//   GET  /api/health           -> { ok, configured, cities }
//   POST /api/plan             -> { name, city, artist_id? } -> Claude agent plan + the Qloo data behind it
//   POST /api/tools/:name      -> run one Qloo tool with a JSON body of arguments
// Every /api request passes a per-IP rate limit. Upstream Qloo and Claude calls also pass daily caps (D1 counter).

import Anthropic from "@anthropic-ai/sdk";
import { makeQloo, d1Cache, d1Budget, QlooError } from "./qloo.js";
import { TOOLS, CITIES } from "./tools.js";
import { runAgent } from "./agent.js";

// Finished plans are kept 14 days so the example plans stay instant through judging.
const PLAN_TTL_S = 14 * 24 * 3600;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

const errorBody = (code, message) => ({ status: "error", summary: message, results: [], result_count: 0, error: { code, message } });
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

function budgetFor(env) {
  return d1Budget(env.DB, { qloo: Number(env.QLOO_DAILY_CAP ?? 1500), claude: Number(env.CLAUDE_DAILY_CAP ?? 150) });
}

async function readJsonObject(request) {
  let args;
  try { args = await request.json(); } catch { throw new QlooError("BAD_INPUT", "Body must be JSON.", 400); }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new QlooError("BAD_INPUT", "Body must be a JSON object.", 400);
  return args;
}

async function handlePlan(request, env) {
  const { name, city, artist_id } = await readJsonObject(request);
  if (typeof name !== "string" || !name.trim() || name.length > 80) throw new QlooError("BAD_INPUT", "name must be 1-80 characters.", 400);
  const cityMatch = CITIES.find((c) => norm(c) === norm(city));
  if (!cityMatch) throw new QlooError("UNSUPPORTED_CITY", `Pick one of: ${CITIES.join(", ")}.`, 400);
  if (artist_id !== undefined && (typeof artist_id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(artist_id))) throw new QlooError("BAD_INPUT", "artist_id must be a Qloo entity ID.", 400);
  if (!env.ANTHROPIC_API_KEY) throw new QlooError("NOT_CONFIGURED", "ANTHROPIC_API_KEY is not set on this Worker.", 500);

  const cache = d1Cache(env.DB);
  const budget = budgetFor(env);
  const qloo = makeQloo({ apiKey: env.QLOO_API_KEY, cache, budget });

  // Finished plans are cached (PLAN_TTL_S), so a repeat demo costs no model calls.
  const planKey = `plan:${artist_id ?? norm(name)}|${cityMatch}`;
  const cached = await cache.get(planKey);
  if (cached) return json({ ...cached, cached: true });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 120_000 });
  const result = await runAgent({ name: name.trim(), city: cityMatch, artist_id }, {
    callClaude: (params) => client.beta.messages.create(params),
    runTool: (tool, args) => {
      if (!TOOLS[tool]) throw new QlooError("UNKNOWN_TOOL", `No tool named ${tool}.`, 400);
      return TOOLS[tool](qloo, args);
    },
    budget,
  });
  const body = { ...result, city: cityMatch };
  if (result.status === "ok") await cache.put(planKey, body, PLAN_TTL_S);
  return json(body, result.status === "error" ? 502 : 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return json(errorBody("NOT_FOUND", "Not found."), 404);

    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    if (env.IP_LIMIT) {
      const { success } = await env.IP_LIMIT.limit({ key: ip });
      if (!success) return json(errorBody("RATE_LIMITED", "Too many requests. Wait a minute."), 429, { "retry-after": "60" });
    }

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, configured: Boolean(env.QLOO_API_KEY), agent: Boolean(env.ANTHROPIC_API_KEY), cities: CITIES });
      }

      if (url.pathname === "/api/plan" && request.method === "POST") return await handlePlan(request, env);

      const m = url.pathname.match(/^\/api\/tools\/([a-z_]+)$/);
      if (m && request.method === "POST") {
        const tool = TOOLS[m[1]];
        if (!tool) return json(errorBody("UNKNOWN_TOOL", `Tools: ${Object.keys(TOOLS).join(", ")}.`), 404);
        const args = await readJsonObject(request);
        const qloo = makeQloo({ apiKey: env.QLOO_API_KEY, cache: d1Cache(env.DB), budget: budgetFor(env) });
        return json(await tool(qloo, args));
      }

      return json(errorBody("NOT_FOUND", "Not found."), 404);
    } catch (e) {
      if (e instanceof QlooError) return json(errorBody(e.code, e.message), e.status);
      if (e instanceof Anthropic.APIError) {
        console.error("claude call failed", e.status, e.message);
        return json(errorBody(e instanceof Anthropic.RateLimitError ? "CLAUDE_RATE_LIMIT" : "CLAUDE_ERROR", "The planning model is unavailable. Try again later."), 503);
      }
      console.error("request failed", url.pathname, e?.stack ?? e);
      return json(errorBody("INTERNAL", "Something went wrong."), 500);
    }
  },
};
