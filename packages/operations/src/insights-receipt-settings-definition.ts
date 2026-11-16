/**
 * Run receipt limits (Insights slice R, listed under "Chat" in Admin → Settings). Definitions
 * only, with no imports, so the admin settings registry and the resolver in
 * `insights-receipt-settings.ts` can both depend on it. Runtime settings rather than Worker vars
 * (`.claude/rules/07`).
 */
export const INSIGHTS_RECEIPT_SETTINGS = [
  {
    name: 'insights.receiptMessageScanMaxRows',
    defaultValue: 10_000,
    description:
      'Most chat messages one run receipt reads to count tool calls. A longer run says its counts are a floor.',
    range: { min: 100, max: 100_000 },
  },
  {
    name: 'insights.receiptWaitingMaxQuestions',
    defaultValue: 200,
    description:
      'Most agent questions one run receipt reads to measure time spent waiting on a person.',
    range: { min: 10, max: 2_000 },
  },
  {
    name: 'insights.receiptComparisonRuns',
    defaultValue: 50,
    description:
      'Most recent runs of the same skill or profile a run receipt reads to find the usual setup and machine wait.',
    range: { min: 3, max: 500 },
  },
  {
    name: 'insights.receiptComparisonWindowDays',
    defaultValue: 30,
    description: 'Days back a run receipt looks for runs to compare with.',
    range: { min: 1, max: 365 },
  },
  {
    name: 'insights.receiptComparisonMinRuns',
    defaultValue: 3,
    description: 'Fewest comparable runs before a run receipt calls a duration slower than usual.',
    range: { min: 1, max: 50 },
  },
  {
    name: 'insights.receiptSlowFactorPercent',
    defaultValue: 150,
    description:
      'A phase is listed as slow when it took at least this percentage of the usual duration.',
    range: { min: 101, max: 1_000 },
  },
  {
    name: 'insights.receiptSlowMinSeconds',
    defaultValue: 60,
    description: 'Phases shorter than this are never listed as slowing a run down.',
    range: { min: 0, max: 3_600 },
  },
  {
    name: 'insights.receiptMemoryNearLimitPercent',
    defaultValue: 90,
    description:
      'Peak memory at or above this percentage of the requested memory is listed as slowing a run down.',
    range: { min: 50, max: 100 },
  },
] as const;

export type InsightsReceiptSettingName = (typeof INSIGHTS_RECEIPT_SETTINGS)[number]['name'];
