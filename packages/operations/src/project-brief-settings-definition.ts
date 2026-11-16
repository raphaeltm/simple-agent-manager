/**
 * The Project Overview brief's controls (inbox slice I, spec 4.3), listed under "AI models" in
 * Admin → Settings. Definitions only, with no imports, so the admin settings registry and the
 * resolver in `project-brief-settings.ts` can both depend on it. Runtime settings rather than
 * Worker vars (policy 9017df94, `.claude/rules/07`).
 *
 * The brief adds recurring platform model spend, so all three bounds are conservative: at the
 * defaults a project can cost at most `dailyCap` generations a day (worst case when its facts
 * change at least every `minIntervalMinutes`).
 */

/** The switch: off means no generation and no brief on any page. */
export const PROJECT_BRIEF_ENABLED_SETTING = {
  name: 'overviewBrief.enabled',
  defaultValue: true,
  description:
    'Show a short generated brief on each Project Overview. Off: no model calls and the page is just its tiles.',
} as const;

export const PROJECT_BRIEF_INTEGER_SETTINGS = [
  {
    name: 'overviewBrief.minIntervalMinutes',
    defaultValue: 30,
    description:
      'Fewest minutes between two briefs for one project. A change sooner waits, and the old brief is shown dimmed.',
    range: { min: 1, max: 1_440 },
  },
  {
    name: 'overviewBrief.dailyCap',
    defaultValue: 24,
    description:
      'Most briefs one project may generate in a UTC day. Past it the old brief stays (dimmed) until the next day.',
    range: { min: 0, max: 288 },
  },
  {
    name: 'overviewBrief.checkIntervalSeconds',
    defaultValue: 60,
    description:
      'Fewest seconds between two checks of whether a project’s facts changed. Each check is one batch of database reads, made after a page view.',
    range: { min: 10, max: 3_600 },
  },
] as const;

export type ProjectBriefIntegerSettingName =
  (typeof PROJECT_BRIEF_INTEGER_SETTINGS)[number]['name'];
export type ProjectBriefSettingName =
  typeof PROJECT_BRIEF_ENABLED_SETTING.name | ProjectBriefIntegerSettingName;
