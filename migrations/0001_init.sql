-- Private server-side cache of Qloo answers (allowed by the hackathon rules; never exported to the repo).
CREATE TABLE IF NOT EXISTS qloo_cache (
  key     TEXT PRIMARY KEY,
  body    TEXT NOT NULL,
  expires INTEGER NOT NULL  -- unix seconds
);

-- Daily usage counters for cost limits. kind = 'qloo' now, 'claude' later.
CREATE TABLE IF NOT EXISTS usage (
  day  TEXT NOT NULL,       -- YYYY-MM-DD (UTC)
  kind TEXT NOT NULL,
  n    INTEGER NOT NULL,
  PRIMARY KEY (day, kind)
);
