/**
 * Admin Health & cost limits (listed under "Operations" in Admin → Settings). Definitions only,
 * with no imports, so the admin settings registry and `insights-installation.ts` can both depend
 * on it. Runtime settings rather than Worker vars (`.claude/rules/07`).
 *
 * Sizes for reference (production, 2026-11-16): ~300 machines and ~2,300 workspace placements
 * and running intervals in 30 days, so the defaults leave more than ten times that headroom. A
 * read that reaches a cap says so (`truncated`) rather than presenting a partial total as whole.
 */
export const INSIGHTS_INSTALLATION_SETTINGS = [
  {
    name: 'insights.healthMaxNodes',
    defaultValue: 5_000,
    description:
      'Machines Admin Health & cost reads for compute spend, newest first. Past it the page marks spend as a lower bound.',
    range: { min: 100, max: 50_000 },
  },
  {
    name: 'insights.healthMaxPlacements',
    defaultValue: 30_000,
    description:
      'Workspace placements Admin Health & cost reads for machine reuse and new-machine reasons, newest first.',
    range: { min: 100, max: 200_000 },
  },
  {
    name: 'insights.healthMaxRuns',
    defaultValue: 30_000,
    description:
      'Running intervals (resource telemetry summaries) Admin Health & cost reads for agents per busy machine.',
    range: { min: 100, max: 200_000 },
  },
  {
    name: 'insights.healthMaxReasons',
    defaultValue: 30,
    description:
      'Distinct reasons Admin Health & cost lists for why new machines were created, most common first. The rest are counted.',
    range: { min: 5, max: 200 },
  },
  {
    name: 'insights.healthSpendWeeks',
    defaultValue: 6,
    description:
      'Weeks shown in the compute spend and machine reuse charts on Admin Health & cost.',
    range: { min: 1, max: 26 },
  },
] as const;

export type InsightsInstallationSettingName =
  (typeof INSIGHTS_INSTALLATION_SETTINGS)[number]['name'];
