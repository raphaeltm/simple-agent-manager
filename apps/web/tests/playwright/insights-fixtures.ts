/**
 * `projectFlow` responses for the Insights and Project Overview audits, shaped exactly as the API
 * answers (`ProjectFlowResponse`). Scenes: a realistic month, a stressed one (long names, many
 * weeks, every stop reason), and an empty project.
 */
import type {
  FlowStopReasonCount,
  InsightsRange,
  ProjectFlowResponse,
} from '@simple-agent-manager/shared';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type FlowScene = 'realistic' | 'stress' | 'empty';

const LONG_CHECK = `apps/api › tests/integration/${'very-long-nested-directory-name/'.repeat(4)}snapshot-retry-with-an-unbroken-identifier.test.ts`;
const LONG_IDEA =
  'Customer portal: let finance teams download every invoice for a period as one zip, with per-line tax totals reconciled against the accounting export and a manifest that lists what was skipped and why';

function buckets(range: InsightsRange, now: number, scene: FlowScene) {
  const weeks = range === '7d' ? 0 : range === '30d' ? 5 : 13;
  const count = range === '7d' ? 8 : weeks + 1;
  const step = range === '7d' ? DAY : 7 * DAY;
  return Array.from({ length: count }, (_, i) => {
    const start = new Date(now - (count - 1 - i) * step).toISOString().slice(0, 10);
    if (scene === 'empty') return { start, merged: 0, closed: 0, failed: 0 };
    const scale = scene === 'stress' ? 6 : 1;
    return {
      start,
      merged: (14 + ((i * 5) % 12)) * scale,
      closed: (1 + (i % 3)) * scale,
      failed: (2 + ((i * 7) % 4)) * scale,
    };
  });
}

const ALL_REASONS: FlowStopReasonCount[] = [
  { reason: 'pr_open', count: 31 },
  { reason: 'ci_failing', count: 18 },
  { reason: 'usage_limit', count: 9 },
  { reason: 'setup_failed', count: 6 },
  { reason: 'agent_stopped', count: 4 },
  { reason: 'stopped_by_coordinator', count: 4 },
  { reason: 'no_machine', count: 3 },
  { reason: 'waiting_on_person', count: 3 },
  { reason: 'ran_too_long', count: 2 },
  { reason: 'session_expired', count: 2 },
  { reason: 'pr_closed', count: 1 },
  { reason: 'stopped_by_person', count: 1 },
  { reason: 'other_error', count: 1 },
];

export function makeFlow(
  projectId: string,
  range: InsightsRange,
  scene: FlowScene,
  now = Date.now()
): ProjectFlowResponse {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const base = {
    projectId,
    range,
    since: new Date(now - days * DAY).toISOString(),
    until: new Date(now).toISOString(),
    generatedAt: new Date(now).toISOString(),
    unavailable: [],
  };
  if (scene === 'empty') {
    return {
      ...base,
      tiles: {
        ideaToMerged: {
          medianMs: null,
          previousMedianMs: null,
          count: 0,
          sampled: { ideas: 0, cap: 100, truncated: false },
        },
        ciFirstTry: { count: 0, of: 0, rate: null, previousRate: null, recorded: 0 },
        waitingOnPerson: { medianMs: null, previousMedianMs: null, count: 0 },
        rework: { count: 0, of: 0, rate: null, previousRate: null, windowDays: 7 },
      },
      merged: { count: 0, previous: 0 },
      runs: {
        bucket: range === '7d' ? 'day' : 'week',
        buckets: buckets(range, now, 'empty'),
        other: { stopped: 0, prOpen: 0, noPullRequest: 0 },
      },
      stopReasons: [],
      flakyChecks: { items: [], total: 0 },
      waitingIdeas: { items: [], total: 0 },
      topBlocker: null,
    };
  }
  const stress = scene === 'stress';
  return {
    ...base,
    tiles: {
      ideaToMerged: {
        medianMs: 1.6 * DAY,
        previousMedianMs: 2 * DAY,
        count: 23,
        sampled: { ideas: 100, cap: 100, truncated: stress },
      },
      ciFirstTry: { count: 32, of: 50, rate: 0.64, previousRate: 0.58, recorded: 54 },
      waitingOnPerson: { medianMs: 22 * 60_000, previousMedianMs: 40 * 60_000, count: 41 },
      rework: { count: 5, of: 46, rate: 5 / 46, previousRate: 0.14, windowDays: 7 },
    },
    merged: { count: stress ? 412 : 28, previous: stress ? 380 : 23 },
    runs: {
      bucket: range === '7d' ? 'day' : 'week',
      buckets: buckets(range, now, scene),
      other: { stopped: 7, prOpen: 3, noPullRequest: 41 },
    },
    stopReasons: stress ? ALL_REASONS : ALL_REASONS.slice(0, 5),
    flakyChecks: {
      items: stress
        ? Array.from({ length: 5 }, (_, i) => ({
            name: i === 0 ? LONG_CHECK : `web › chat-scroll-${i}.spec.ts`,
            flips: 18 - i * 3,
            commits: 60,
          }))
        : [
            { name: 'apps/api › snapshot-retry.test.ts', flips: 18, commits: 60 },
            { name: 'web › chat-scroll.spec.ts', flips: 6, commits: 60 },
          ],
      total: stress ? 14 : 2,
    },
    waitingIdeas: {
      items: [
        {
          ideaId: 'idea-a',
          title: stress ? LONG_IDEA : 'Customer portal: download invoices as zip',
          createdAt: new Date(now - 9 * DAY).toISOString(),
          state: 'stuck',
          chats: 2,
          pullRequest: null,
          note: 'Stopped on review',
        },
        {
          ideaId: 'idea-b',
          title: 'Dunning schedule per plan',
          createdAt: new Date(now - 6 * DAY).toISOString(),
          state: 'not-started',
          chats: 0,
          pullRequest: null,
          note: null,
        },
        {
          ideaId: 'idea-c',
          title: stress
            ? `<script>alert("x")</script> Tax ID validation for UK 🇬🇧`
            : 'Tax ID validation for UK',
          createdAt: new Date(now - 4 * DAY - 3 * HOUR).toISOString(),
          state: 'review',
          chats: 1,
          pullRequest: { number: 2770, checksState: 'failure' },
          note: null,
        },
      ],
      total: stress ? 37 : 3,
    },
    topBlocker: { kind: 'flaky_check', name: 'apps/api › snapshot-retry.test.ts', flips: 18 },
  };
}
