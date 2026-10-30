import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, CLAUDE_TOOLS, MAX_MODEL_CALLS, MODEL } from "../src/agent.js";
import { QlooError } from "../src/qloo.js";
import { memoryBudget, ID } from "./helpers.js";

// Scripted Claude: returns the given responses in order and records every request.
function scriptedClaude(responses) {
  const requests = [];
  const fn = async (params) => {
    requests.push(structuredClone(params));
    const r = responses[requests.length - 1];
    if (!r) throw new Error("no scripted response left");
    return { usage: { input_tokens: 10, output_tokens: 5 }, ...r };
  };
  fn.requests = requests;
  return fn;
}
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
const turn = (...content) => ({ stop_reason: content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn", content });

const PLAN = { headline: "h", sections: [{ title: "t", text: "x", source: "proxy_data" }], caveats: ["c"] };
const ENV = {
  resolve_artist: { status: "ok", summary: "Matched Phyno.", results: [{ artist_id: ID(1), name: "Phyno" }] },
  fan_map: { status: "ok", summary: "proxy", source: "proxy", proxy: { name: "Ajebutter22" }, area_count: 234, tried: [], results: Array(234).fill({ lat: 1, lon: 2 }) },
  fan_places: { status: "ok", summary: "places", results: [{ name: "Enish", neighborhood: "Camberwell", kind: "West African restaurant", live_music: true, event_space: true, lat: 1, lon: 2 }] },
  opening_acts: { status: "ok", summary: "acts", results: [{ name: "Olamide", list: "shared_fans" }, { name: "Amaarae", list: "local_scene" }] },
};

test("tool definitions are strict with closed schemas (required for strict: true)", () => {
  for (const t of CLAUDE_TOOLS) {
    assert.equal(t.strict, true, t.name);
    assert.equal(t.input_schema.additionalProperties, false, t.name);
    assert.deepEqual([...t.input_schema.required].sort(), Object.keys(t.input_schema.properties).sort(), t.name);
  }
});

test("full run: resolve, three tools in one turn, submit_plan; map cells stay out of the prompt", async () => {
  const claude = scriptedClaude([
    turn(toolUse("a", "resolve_artist", { name: "Phyno" })),
    turn({ type: "thinking", thinking: "", signature: "sig" }, toolUse("b", "fan_map", { artist_id: ID(1), artist_name: "Phyno", city: "London" }), toolUse("c", "fan_places", { artist_id: ID(1), city: "London" }), toolUse("d", "opening_acts", { artist_id: ID(1), city: "London" })),
    turn(toolUse("e", "submit_plan", PLAN)),
  ]);
  const ran = [];
  const out = await runAgent({ name: "Phyno", city: "London" }, { callClaude: claude, runTool: async (n) => { ran.push(n); return ENV[n]; }, budget: memoryBudget() });

  assert.equal(out.status, "ok");
  assert.deepEqual(out.plan, PLAN);
  assert.deepEqual(ran, ["resolve_artist", "fan_map", "fan_places", "opening_acts"]);
  assert.equal(out.data.fan_map.results.length, 234, "UI still gets the full map");
  assert.equal(out.usage.model_calls, 3);

  const third = claude.requests[2];
  assert.equal(third.model, MODEL);
  assert.equal(third.fallbacks, "default");
  assert.ok(!("tool_choice" in third), "no forced tool_choice (400 on this model)");
  // All three results come back in ONE user message, and the 234 cells are not sent to the model.
  const results = third.messages[4].content;
  assert.equal(results.length, 3);
  const mapResult = JSON.parse(results.find((r) => r.tool_use_id === "b").content);
  assert.equal(mapResult.proxy, "Ajebutter22");
  assert.ok(!("results" in mapResult));
  // History is append-only: the assistant turn with the thinking block is passed back unchanged.
  assert.equal(third.messages[3].content[0].type, "thinking");
  assert.equal(third.messages[3].content[0].signature, "sig");
});

test("ambiguous artist stops after resolve and returns candidates, without more model calls", async () => {
  const claude = scriptedClaude([turn(toolUse("a", "resolve_artist", { name: "Ice" }))]);
  const amb = { status: "needs_input", summary: "pick one", results: [{ artist_id: ID(2), name: "Ice Cube" }, { artist_id: ID(3), name: "Ice Prince" }] };
  const out = await runAgent({ name: "Ice", city: "London" }, { callClaude: claude, runTool: async () => amb, budget: memoryBudget() });
  assert.equal(out.status, "needs_input");
  assert.equal(out.candidates.length, 2);
  assert.equal(claude.requests.length, 1);
});

test("confirmed artist_id is passed to the model so it can skip resolve", async () => {
  const claude = scriptedClaude([turn(toolUse("e", "submit_plan", PLAN))]);
  await runAgent({ name: "Phyno", city: "London", artist_id: ID(1) }, { callClaude: claude, runTool: async () => ({}), budget: memoryBudget() });
  assert.match(claude.requests[0].messages[0].content, new RegExp(ID(1)));
});

test("a failing Qloo tool becomes an is_error result; the run continues", async () => {
  const claude = scriptedClaude([
    turn(toolUse("b", "fan_places", { artist_id: ID(1), city: "London" })),
    turn(toolUse("e", "submit_plan", PLAN)),
  ]);
  const out = await runAgent({ name: "Phyno", city: "London", artist_id: ID(1) }, {
    callClaude: claude, runTool: async () => { throw new QlooError("QLOO_TIMEOUT", "slow", 504); }, budget: memoryBudget(),
  });
  assert.equal(out.status, "ok");
  const r = claude.requests[1].messages[2].content[0];
  assert.equal(r.is_error, true);
  assert.match(r.content, /QLOO_TIMEOUT/);
});

test("daily Claude cap stops before the call that would exceed it", async () => {
  const claude = scriptedClaude([turn(toolUse("a", "resolve_artist", { name: "Phyno" }))]);
  await assert.rejects(
    runAgent({ name: "Phyno", city: "London" }, { callClaude: claude, runTool: async () => ENV.resolve_artist, budget: memoryBudget(1) }),
    (e) => e.code === "DAILY_CAP",
  );
  assert.equal(claude.requests.length, 1);
});

test("refusal and max_tokens end the run with clear errors", async () => {
  for (const [stop, code] of [["refusal", "REFUSED"], ["max_tokens", "TRUNCATED"]]) {
    const claude = scriptedClaude([{ stop_reason: stop, content: [] }]);
    const out = await runAgent({ name: "X", city: "London" }, { callClaude: claude, runTool: async () => ({}), budget: memoryBudget() });
    assert.equal(out.error.code, code);
  }
});

test("loop is bounded: a model that never submits stops after MAX_MODEL_CALLS", async () => {
  const forever = Array.from({ length: MAX_MODEL_CALLS + 3 }, (_, i) => turn(toolUse(`t${i}`, "fan_places", { artist_id: ID(1), city: "London" })));
  const claude = scriptedClaude(forever);
  const out = await runAgent({ name: "Phyno", city: "London", artist_id: ID(1) }, { callClaude: claude, runTool: async () => ENV.fan_places, budget: memoryBudget() });
  assert.equal(out.error.code, "TOO_MANY_STEPS");
  assert.equal(claude.requests.length, MAX_MODEL_CALLS);
});

test("not_active artists reach the model as their own list, never inside shared_fans", async () => {
  const claude = scriptedClaude([
    turn(toolUse("d", "opening_acts", { artist_id: ID(1), city: "London" })),
    turn(toolUse("e", "submit_plan", PLAN)),
  ]);
  const acts = { status: "ok", summary: "acts", results: [{ name: "Olamide", list: "shared_fans" }, { name: "Dagrin", list: "not_active", end_year: 2010 }] };
  await runAgent({ name: "Phyno", city: "London", artist_id: ID(1) }, { callClaude: claude, runTool: async () => acts, budget: memoryBudget() });
  const seen = JSON.parse(claude.requests[1].messages[2].content[0].content);
  assert.deepEqual(seen.shared_fans, ["Olamide"]);
  assert.deepEqual(seen.not_active, [{ name: "Dagrin", end_year: 2010 }]);
});
