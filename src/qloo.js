// Qloo REST client with a private cache and a daily cap on upstream calls.
// One try per request, no retries (bounded by design). The key never leaves the Worker.

export const QLOO_BASE = "https://hackathon.api.qloo.com";
const TIMEOUT_MS = 20000;
const CACHE_TTL_S = 7 * 24 * 3600;

export class QlooError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Stable cache key: path + params sorted by name. Arrays are joined with commas, as Qloo expects.
export function requestKey(path, params) {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)])
    .sort(([a], [b]) => a.localeCompare(b));
  return `${path}?${new URLSearchParams(entries)}`;
}

// cache: { get(key) -> object|null, put(key, object, ttlSeconds) }
// budget: { spend(kind) } — throws QlooError("DAILY_CAP") when the day's cap is used up.
export function makeQloo({ apiKey, cache, budget, fetchImpl = fetch }) {
  if (!apiKey) throw new QlooError("NOT_CONFIGURED", "QLOO_API_KEY is not set on this Worker.", 500);

  return async function qloo(path, params) {
    const key = requestKey(path, params);
    const request = { path, params };

    const hit = await cache.get(key);
    if (hit) return { body: hit, cached: true, request };

    await budget.spend("qloo");
    let res;
    try {
      res = await fetchImpl(`${QLOO_BASE}${key}`, {
        headers: { "X-Api-Key": apiKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const timeout = e?.name === "TimeoutError";
      throw new QlooError(timeout ? "QLOO_TIMEOUT" : "QLOO_NETWORK", timeout ? `Qloo did not answer in ${TIMEOUT_MS / 1000}s.` : "Could not reach Qloo.", 504);
    }

    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }

    if (res.status === 401 || res.status === 403) throw new QlooError("QLOO_AUTH", "Qloo rejected the key or the entity type.", 502);
    if (res.status === 429) throw new QlooError("QLOO_RATE_LIMIT", "Qloo rate limit reached. Try again later.", 503);
    if (!res.ok) {
      const message = body?.errors?.[0]?.message ?? body?.message ?? text.slice(0, 200);
      throw new QlooError(res.status === 400 ? "QLOO_BAD_REQUEST" : "QLOO_UPSTREAM", message, 502);
    }
    if (body === null) throw new QlooError("QLOO_UPSTREAM", "Qloo returned a non-JSON answer.", 502);

    await cache.put(key, body, CACHE_TTL_S);
    return { body, cached: false, request };
  };
}

// ---- D1-backed cache and budget ----

export function d1Cache(db, now = () => Math.floor(Date.now() / 1000)) {
  return {
    async get(key) {
      const row = await db.prepare("SELECT body, expires FROM qloo_cache WHERE key = ?").bind(key).first();
      if (!row || row.expires < now()) return null;
      return JSON.parse(row.body);
    },
    async put(key, body, ttl) {
      await db.prepare("INSERT INTO qloo_cache (key, body, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, expires = excluded.expires")
        .bind(key, JSON.stringify(body), now() + ttl).run();
    },
  };
}

// Counts BEFORE the upstream call, so failed calls count too (the safe direction for a cost cap).
export function d1Budget(db, caps, today = () => new Date().toISOString().slice(0, 10)) {
  return {
    async spend(kind) {
      const cap = caps[kind];
      const row = await db.prepare("INSERT INTO usage (day, kind, n) VALUES (?, ?, 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1 RETURNING n")
        .bind(today(), kind).first();
      if (cap !== undefined && row.n > cap) {
        throw new QlooError("DAILY_CAP", `Daily limit of ${cap} ${kind} calls reached. Cached results still work. Try again tomorrow (UTC).`, 503);
      }
      return row.n;
    },
  };
}
