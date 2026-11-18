/**
 * Cloudflare cost snapshot settings (Insights slice CF, listed under "Operations" in Admin →
 * Settings). Definitions only, with no imports, so the admin settings registry, the snapshot job
 * and the Health & cost read can all depend on it. Runtime settings rather than Worker vars
 * (`.claude/rules/07`).
 *
 * Throughput (`.claude/rules/81`): each run makes ONE Cloudflare GraphQL request covering the last
 * `insights.cloudflareCostBackfillDays` complete days and upserts one row per day per product line
 * (19 lines, so at most 31 × 19 = 589 rows in one D1 batch). Cloudflare serves no data older than
 * 4w4d and refuses a wider range, so 31 days is both the hard maximum and the outer limit of a
 * backfill: a gap of any length is filled back to 31 days on the next run (daily at 03:00 UTC, or
 * at once with "Refresh now"); anything older can never be fetched and is shown as missing.
 */
export const INSIGHTS_CLOUDFLARE_COST_SETTINGS = [
  {
    name: 'insights.cloudflareCostBackfillDays',
    defaultValue: 30,
    description:
      'Complete days the daily Cloudflare cost snapshot re-fetches and stores on each run. Cloudflare serves at most the last 31 days.',
    // max mirrors CLOUDFLARE_ANALYTICS_MAX_DAYS (packages/shared); a test pins the two together.
    range: { min: 1, max: 31 },
  },
  {
    name: 'insights.cloudflareCostQueryLimit',
    defaultValue: 10_000,
    description:
      'Rows per Cloudflare analytics dataset one snapshot request may return. A dataset that reaches it fails the run rather than storing a partial estimate.',
    range: { min: 100, max: 100_000 },
  },
  {
    name: 'insights.cloudflareCostRefreshMinSeconds',
    defaultValue: 60,
    description:
      'Seconds after one Cloudflare cost snapshot attempt before Refresh now on Admin Health & cost may start another. The daily run is not limited.',
    range: { min: 10, max: 3_600 },
  },
] as const;

export type InsightsCloudflareCostSettingName =
  (typeof INSIGHTS_CLOUDFLARE_COST_SETTINGS)[number]['name'];
