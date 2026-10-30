// Claude agent loop for the tour planner.
// Claude decides which Qloo tools to call and writes the plan; Qloo supplies every fact.
// Bounded by design: at most MAX_MODEL_CALLS model calls per plan, every call counted against a daily cap,
// no open-ended retries. An ambiguous artist name stops the loop and goes back to the user.

import { QlooError } from "./qloo.js";
import { CITIES } from "./tools.js";

export const MODEL = "claude-opus-5-5";
export const MAX_MODEL_CALLS = 6;
const MAX_TOKENS = 16000;

export const SYSTEM_PROMPT = `You help managers and promoters of rising African artists plan a first show in a diaspora city.

You get an artist and a city. Use the tools to collect Qloo data, then call submit_plan once.

How to work:
1. If you have no artist_id, call resolve_artist first. If it does not return status "ok", stop and say in one sentence that the user must pick the artist. Do not guess.
2. Call fan_map, fan_places and opening_acts. They do not depend on each other, so call them together.
3. Call submit_plan with a short plan built only from the tool results.

Rules for the plan:
- Every section has a source: "artist_data" (Qloo data for this artist), "proxy_data" (Qloo data for a similar artist, because this artist has too little), or "ai_summary" (your own reading of the results).
- You cannot see the map. fan_map gives you only its source and size, so never say which areas or neighbourhoods the fans cluster in; say the map shows it. Neighbourhood names come only from fan_places, and describe where the places are, not where the fans are.
- If fan_map used a proxy, name the proxy artist and say the map shows where fans of this kind of music cluster, not this artist's own fans.
- Places can be restaurants, lounges or churches, not only stages. Say which ones Qloo marks as having live music or event space.
- Keep the two opening-act lists apart: artists who share fans, and artists distinctive to the city's audience. Do not merge them into one claim.
- Never suggest an artist from not_active: Qloo says they stopped performing (died, or the group split). If the list is not empty, say who was left out and why. Qloo does not mark every such artist, so add a caveat that the user must check that each suggested artist still performs.
- Qloo describes what groups with a shared taste like, not what one person will do, and not ticket sales. Never write a number, place or artist that is not in the tool results.
- Plain, short sentences. No marketing language.`;

const s = (props, required = Object.keys(props)) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description) => ({ type: "string", description });

export const CLAUDE_TOOLS = [
  {
    name: "resolve_artist",
    description: "Find the Qloo artist for a typed name. Returns status ok (one match), needs_input (ambiguous) or empty (no match), plus candidates with artist_id.",
    input_schema: s({ name: str("Artist name as the user typed it.") }),
  },
  {
    name: "fan_map",
    description: "Where in the city this artist's fans cluster (Qloo heatmap). Uses the artist's own data if it has enough, otherwise the closest similar artist that does, and says which.",
    input_schema: s({ artist_id: str("Qloo artist_id from resolve_artist."), artist_name: str("Artist display name."), city: { type: "string", enum: CITIES } }),
  },
  {
    name: "fan_places",
    description: "Places in the city that match this artist's fans, with neighbourhood, type, and live-music / event-space flags.",
    input_schema: s({ artist_id: str("Qloo artist_id."), city: { type: "string", enum: CITIES } }),
  },
  {
    name: "opening_acts",
    description: "Two separate lists: artists who share fans with this artist, and Afrobeats artists distinctive to the city's audience.",
    input_schema: s({ artist_id: str("Qloo artist_id."), city: { type: "string", enum: CITIES } }),
  },
  {
    name: "submit_plan",
    description: "Submit the final plan. Call once, last.",
    input_schema: s({
      headline: str("One sentence: the most useful finding, with the artist and city."),
      sections: {
        type: "array",
        items: s({
          title: str("Short title, e.g. 'Where the fans are', 'Places', 'Opening acts'."),
          text: str("2-4 plain sentences."),
          source: { type: "string", enum: ["artist_data", "proxy_data", "ai_summary"] },
        }),
      },
      caveats: { type: "array", items: { type: "string" }, description: "What this plan does not show." },
    }),
  },
].map((t) => ({ ...t, strict: true }));

// What Claude sees from each tool: the summary and small facts, never the 300 map cells.
function forModel(name, env) {
  if (env.status === "error") return { status: "error", summary: env.summary };
  switch (name) {
    case "resolve_artist":
      return { status: env.status, summary: env.summary, candidates: env.results.slice(0, 5) };
    case "fan_map":
      return { status: env.status, summary: env.summary, source: env.source, proxy: env.proxy?.name ?? null, area_count: env.area_count, tried: env.tried };
    case "fan_places":
      return { status: env.status, summary: env.summary, places: env.results.map(({ name, neighborhood, kind, live_music, event_space }) => ({ name, neighborhood, kind, live_music, event_space })) };
    case "opening_acts":
      return {
        status: env.status, summary: env.summary,
        shared_fans: env.results.filter((a) => a.list === "shared_fans").map((a) => a.name),
        local_scene: env.results.filter((a) => a.list === "local_scene").map((a) => a.name),
        not_active: env.results.filter((a) => a.list === "not_active").map((a) => ({ name: a.name, end_year: a.end_year })),
      };
    default:
      return env;
  }
}

// deps:
//   callClaude(params) -> Anthropic message (the Worker wraps client.beta.messages.create)
//   runTool(name, args) -> tool envelope (the Worker wraps TOOLS[name](qloo, args))
//   budget.spend("claude") -> throws QlooError("DAILY_CAP") when the day's cap is used
export async function runAgent({ name, city, artist_id }, { callClaude, runTool, budget }) {
  const userText = artist_id
    ? `Artist: ${name} (artist_id ${artist_id}, already confirmed by the user). City: ${city}.`
    : `Artist: ${name}. City: ${city}.`;
  const messages = [{ role: "user", content: userText }];
  const data = {}; // full tool envelopes for the UI (map cells, coordinates, provenance)
  const usage = { model_calls: 0, input_tokens: 0, output_tokens: 0 };

  for (let i = 0; i < MAX_MODEL_CALLS; i++) {
    await budget.spend("claude");
    const response = await callClaude({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      tools: CLAUDE_TOOLS,
      messages,
    });
    usage.model_calls += 1;
    usage.input_tokens += response.usage?.input_tokens ?? 0;
    usage.output_tokens += response.usage?.output_tokens ?? 0;

    if (response.stop_reason === "refusal") {
      return { status: "error", error: { code: "REFUSED", message: "The model declined this request." }, data, usage };
    }
    if (response.stop_reason === "max_tokens") {
      return { status: "error", error: { code: "TRUNCATED", message: "The model ran out of output space." }, data, usage };
    }
    // Append the full content unchanged (thinking blocks included) — the history stays append-only.
    messages.push({ role: "assistant", content: response.content });

    const calls = response.content.filter((b) => b.type === "tool_use");
    const submit = calls.find((c) => c.name === "submit_plan");
    if (submit) return { status: "ok", plan: submit.input, data, usage };

    if (!calls.length) {
      const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      // The model stopped without a plan: only expected when the artist needs confirming.
      const needs = data.resolve_artist && data.resolve_artist.status !== "ok";
      return { status: needs ? data.resolve_artist.status : "error", message: text, candidates: data.resolve_artist?.results ?? [], data, usage,
        ...(needs ? {} : { error: { code: "NO_PLAN", message: text || "The model stopped without a plan." } }) };
    }

    // Run this turn's tool calls together; return all results in one user message.
    const results = await Promise.all(calls.map(async (c) => {
      let env;
      try {
        env = await runTool(c.name, c.input);
      } catch (e) {
        if (!(e instanceof QlooError)) throw e;
        if (e.code === "DAILY_CAP") throw e; // stop the whole plan, not just one tool
        env = { status: "error", summary: `${e.code}: ${e.message}`, results: [] };
      }
      data[c.name] = env;
      return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(forModel(c.name, env)), ...(env.status === "error" ? { is_error: true } : {}) };
    }));
    messages.push({ role: "user", content: results });

    // Ambiguous or unknown artist: stop here and let the user choose. Do not spend more model calls.
    if (data.resolve_artist && data.resolve_artist.status !== "ok" && calls.every((c) => c.name === "resolve_artist")) {
      return { status: data.resolve_artist.status, message: data.resolve_artist.summary, candidates: data.resolve_artist.results, data, usage };
    }
  }
  return { status: "error", error: { code: "TOO_MANY_STEPS", message: `No plan after ${MAX_MODEL_CALLS} model calls.` }, data, usage };
}
