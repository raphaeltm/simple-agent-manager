-- Insights slice CF (idea 01M7HTS38KX2G78JD0ESAGMKKH): a daily, usage-derived estimate of what
-- the Cloudflare account costs, for the Cloudflare card on Admin › Health & cost.
--   Writer: runCloudflareCostSnapshot() (apps/api/src/services/cloudflare-cost-snapshot.ts), run
--           by the daily 03:00 UTC cron and by the superadmin "Refresh now" button.
--   Reader: readCloudflareCost() (packages/operations/src/insights-installation-cloudflare.ts).
--
-- One row per UTC day per product line (a billed metric key such as `workersRequests` or
-- `doDurationGbSeconds`, see CLOUDFLARE_COST_METRIC_KEYS in packages/shared). The snapshot job
-- re-fetches its whole window on every run and upserts, so a day is idempotent. Costs are
-- estimates at Cloudflare's list prices, in USD. fetched_at is epoch milliseconds.
--
-- Additive only (rule 31): two new tables. Numbered 0256 to stay clear of 0253-0255 (open PRs
-- #2811, #2818, #2821).
CREATE TABLE IF NOT EXISTS installation_cost_daily (
  source TEXT NOT NULL,
  day TEXT NOT NULL,
  product_line TEXT NOT NULL,
  usage_quantity REAL NOT NULL,
  usage_unit TEXT NOT NULL,
  estimated_cost_usd REAL NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (source, day, product_line)
);

-- The latest snapshot attempt per source, so the card can say why it has no data
-- (not configured, token lacks permission, last fetch failed) without reading logs.
CREATE TABLE IF NOT EXISTS installation_cost_sync (
  source TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  last_success_at INTEGER,
  error_message TEXT,
  first_day TEXT,
  last_day TEXT,
  rows_written INTEGER NOT NULL DEFAULT 0
);
