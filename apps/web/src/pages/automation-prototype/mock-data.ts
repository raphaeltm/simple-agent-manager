/**
 * Mock data for the Automation prototype (dev-only route /prototype/automation).
 *
 * Shapes are production-like (see the 2026-10-20 audit, idea 01M5CYV085D3N1Z5PZD8C5JN2D):
 * agent-created waits on CI and reviews, SAM-internal message relays, a trigger that
 * paused itself after failures, a watch at its run limit, a one-off message whose
 * delivery could not be confirmed, a webhook with ignored deliveries, an unlisted
 * timezone, long names and prompts. IDs are obviously fake.
 */

import { nextOccurrence, previousOccurrence, whenLabel } from './time';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const NOW = Date.now();
export const at = (offsetMin: number) => NOW + offsetMin * MIN;

const WEEKDAYS = [1, 2, 3, 4, 5];
const MONDAY = [1];
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const notLocal = (zone: string, label: string) => (zone === localZone ? undefined : label);

// Recurring times are real wall-clock occurrences, so "Every day at 7:00 AM" and
// "Next: Tomorrow 7:00 AM" always agree, whatever time the prototype is opened.
const JOURNAL_NEXT = nextOccurrence(NOW, 7, 0);
export const JOURNAL_LAST = previousOccurrence(NOW, 7, 0);
const STANDUP_NEXT = nextOccurrence(NOW, 8, 30, WEEKDAYS, 'America/Toronto');
export const STANDUP_LAST = previousOccurrence(NOW, 8, 30, WEEKDAYS, 'America/Toronto');
const DOCS_NEXT = nextOccurrence(NOW, 5, 0, MONDAY, 'UTC');
export const DOCS_LAST = previousOccurrence(NOW, 5, 0, MONDAY, 'UTC');
const RELEASE_DUE = at(95);
const FLAKY_DUE = at(-3 * 60 - 7);
const DEPS_DUE = nextOccurrence(NOW + 36 * HOUR, 8, 0);
export const FOLLOWUP_DUE = at(-4 * 60 - 5);
export const STORAGE_DUE = at(-3 * 60 - 2);
const OLD_REMINDER_DUE = at(-2 * 24 * 60 - 40);
const once = (ts: number) => whenLabel(ts).replace(/^(Today|Tomorrow|Yesterday) /, '$1 at ');
const fullDue = (ts: number) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(ts);

export type Kind = 'schedule' | 'once' | 'github' | 'webhook' | 'event' | 'incident';
export type State = 'on' | 'paused' | 'off' | 'scheduled' | 'retrying' | 'finished' | 'cancelled';
export type Outcome = 'ok' | 'failed' | 'skipped' | 'ignored' | 'running' | 'delivered' | 'unknown';

export interface Profile {
  id: string;
  name: string;
  model: string;
}

export const PROFILES: Profile[] = [
  { id: 'p-codex', name: 'Codex 5.5 High Chat', model: 'gpt-5.5 · high' },
  { id: 'p-backend', name: 'Backend Implementation', model: 'gpt-6.1-sol' },
  { id: 'p-frontend', name: 'Frontend Implementation', model: 'claude-opus-5-5' },
];

export interface Chat {
  id: string;
  title: string;
  state: 'active' | 'sleeping' | 'stopped';
}

export const CHATS: Chat[] = [
  { id: 'chat-release', title: 'PR #2387 release shepherd', state: 'sleeping' },
  { id: 'chat-webhook', title: 'Fix webhook delivery retries', state: 'active' },
  { id: 'chat-comments', title: 'Multiplayer comments follow-ups', state: 'sleeping' },
  { id: 'chat-audit', title: 'Audit events UI and subpages', state: 'active' },
  { id: 'chat-deps', title: 'Weekly dependency review', state: 'stopped' },
];

export const chatTitle = (id: string) => CHATS.find((c) => c.id === id)?.title ?? 'a chat';
export const chatAt = (i: number): Chat =>
  CHATS[i % CHATS.length] ?? { id: 'chat-unknown', title: 'a chat', state: 'stopped' };

export type Action =
  | { type: 'start'; profileId: string; prompt: string }
  | { type: 'message'; chatId: string; prompt: string };

export interface Attention {
  tone: 'danger' | 'warning';
  title: string;
  body: string;
  primary: string;
  secondary?: string;
}

export interface Automation {
  id: string;
  name: string;
  kind: Kind;
  state: State;
  /** Plain-language "when", e.g. "Every day at 7:00 AM". */
  when: string;
  /** Short qualifier shown after the when, e.g. the timezone. */
  whenNote?: string;
  nextAt: number | null;
  action: Action;
  lastRun?: { at: number; outcome: Outcome };
  runs: number;
  createdBy: string;
  createdAt: number;
  attention?: Attention;
  /** One sentence shown under the state, in plain words. */
  stateNote?: string;
  /** Things a power user may need, shown under "Advanced". */
  advanced: Array<[string, string]>;
  personalKey?: string;
  webhook?: { label: string; tokenEnd: string; filter: string };
}

const SHEPHERD_PROMPT =
  'Review every open pull request. Fix failing checks when the fix is small and obvious, rebase stale branches, and merge PRs that are green, reviewed and not drafts. Leave a short note on anything you skip and why.';

export const AUTOMATIONS: Automation[] = [
  {
    id: 'shepherd',
    name: 'PR Shepherd (steady-state blitz)',
    kind: 'schedule',
    state: 'paused',
    when: 'Every 6 hours',
    whenNote: 'UTC',
    nextAt: null,
    action: { type: 'start', profileId: 'p-codex', prompt: SHEPHERD_PROMPT },
    lastRun: { at: at(-9 * 60), outcome: 'failed' },
    runs: 168,
    createdBy: 'Raphaël',
    createdAt: NOW - 112 * DAY,
    attention: {
      tone: 'danger',
      title: 'Paused itself after 3 failed runs in a row',
      body: 'Last failure: the run was still going after the 30-minute limit, so SAM gave up on it. Resuming starts the count again.',
      primary: 'Resume',
      secondary: 'See failed runs',
    },
    stateNote: 'Paused by SAM after 3 failures',
    advanced: [
      ['Cron', '0 */6 * * *'],
      ['Timezone', 'UTC'],
      ['If the last run is still going', 'Skip this run'],
      ['Runs at the same time', 'At most 1'],
      ['Machine', 'Profile default'],
      ['Chat type', 'Task (finishes on its own)'],
      ['Auto-pause after', '3 failed runs in a row'],
      ['Trigger ID', 'trg_01M5MOCKSHEPHERD000000001'],
    ],
  },
  {
    id: 'release-check',
    name: 'Check on the release after the morning deploy',
    kind: 'once',
    state: 'scheduled',
    when: once(RELEASE_DUE),
    nextAt: RELEASE_DUE,
    action: {
      type: 'message',
      chatId: 'chat-release',
      prompt: 'Check whether Deploy Production for PR #2387 finished and report the result.',
    },
    runs: 0,
    createdBy: 'Raphaël',
    createdAt: NOW - 70 * MIN,
    stateNote: 'If the chat is busy, SAM waits up to 1 hour',
    advanced: [
      ['Due', fullDue(RELEASE_DUE)],
      ['Give up after', fullDue(RELEASE_DUE + HOUR)],
      ['Created from', 'PR #2387 release shepherd'],
      ['Schedule ID', 'sch_01M5MOCKSCHD0000000000001'],
      ['Version', '1'],
    ],
  },
  {
    id: 'flaky',
    name: 'Re-run the flaky webhook test',
    kind: 'once',
    state: 'retrying',
    when: once(FLAKY_DUE),
    nextAt: at(4),
    action: {
      type: 'message',
      chatId: 'chat-webhook',
      prompt: 'Re-run the flaky webhook delivery test 5 times and tell me if it still fails.',
    },
    runs: 0,
    createdBy: 'Raphaël',
    createdAt: NOW - 3 * HOUR,
    stateNote: 'The chat is busy. Trying again in 4 min (attempt 4 of 12).',
    advanced: [
      ['Due', fullDue(FLAKY_DUE)],
      ['Give up after', fullDue(FLAKY_DUE + 4 * HOUR)],
      ['Attempts', '3 (last: target session busy)'],
      ['Schedule ID', 'sch_01M5MOCKSCHD0000000000003'],
    ],
  },
  {
    id: 'standup',
    name: 'Morning standup summary for the multiplayer collaboration workstream — comments, mentions, shared chats and the review shortcut',
    kind: 'schedule',
    state: 'on',
    when: 'Weekdays at 8:30 AM',
    whenNote: notLocal('America/Toronto', 'Toronto time'),
    nextAt: STANDUP_NEXT,
    action: {
      type: 'start',
      profileId: 'p-frontend',
      prompt:
        'Summarize yesterday’s work on multiplayer sessions: merged PRs, open review threads, unanswered @mentions and anything blocked. Post the summary to #feature.multiplayer and keep it under 15 bullet points.',
    },
    lastRun: { at: STANDUP_LAST, outcome: 'ok' },
    runs: 31,
    createdBy: 'Sam Rivera',
    createdAt: NOW - 40 * DAY,
    personalKey: 'Sam Rivera',
    advanced: [
      ['Cron', '30 8 * * 1-5'],
      ['Timezone', 'America/Toronto'],
      ['If the last run is still going', 'Skip this run'],
      ['Machine', '2 vCPU · 4 GB'],
      ['Chat type', 'Task (finishes on its own)'],
      ['Trigger ID', 'trg_01M5MOCKSTANDUP0000000001'],
    ],
  },
  {
    id: 'journal',
    name: 'Daily SAM journal',
    kind: 'schedule',
    state: 'on',
    when: 'Every day at 7:00 AM',
    nextAt: JOURNAL_NEXT,
    action: {
      type: 'start',
      profileId: 'p-frontend',
      prompt:
        'Write the daily SAM journal post if something technically interesting shipped in the last day. Publish nothing otherwise.',
    },
    lastRun: { at: JOURNAL_LAST, outcome: 'ok' },
    runs: 61,
    createdBy: 'Raphaël',
    createdAt: NOW - 62 * DAY,
    advanced: [
      ['Cron', '0 7 * * *'],
      ['Timezone', localZone],
      ['If the last run is still going', 'Skip this run'],
      ['Chat type', 'Task (finishes on its own)'],
      ['Trigger ID', 'trg_01M5MOCKJOURNAL0000000001'],
    ],
  },
  {
    id: 'deps',
    name: 'Start the weekly dependency review',
    kind: 'once',
    state: 'scheduled',
    when: once(DEPS_DUE),
    nextAt: DEPS_DUE,
    action: {
      type: 'start',
      profileId: 'p-codex',
      prompt: 'Run the weekly dependency review and open a PR if anything needs bumping.',
    },
    runs: 0,
    createdBy: 'Raphaël',
    createdAt: NOW - 70 * MIN,
    advanced: [
      ['Give up after', fullDue(DEPS_DUE + HOUR)],
      ['Schedule ID', 'sch_01M5MOCKSCHD0000000000002'],
    ],
  },
  {
    id: 'docs',
    name: 'Weekly docs pass',
    kind: 'schedule',
    state: 'on',
    when: 'Mondays at 5:00 AM',
    whenNote: 'UTC',
    nextAt: DOCS_NEXT,
    action: {
      type: 'start',
      profileId: 'p-frontend',
      prompt:
        'Compare the public docs with what shipped this week and fix anything that is now wrong.',
    },
    lastRun: { at: DOCS_LAST, outcome: 'ok' },
    runs: 14,
    createdBy: 'Raphaël',
    createdAt: NOW - 98 * DAY,
    personalKey: 'Raphaël',
    advanced: [
      ['Cron', '0 5 * * 1'],
      ['Timezone', 'UTC'],
      ['Trigger ID', 'trg_01M5MOCKDOCS000000000001'],
    ],
  },
  {
    id: 'deploy',
    name: 'Investigate failed deploys',
    kind: 'webhook',
    state: 'on',
    when: 'When GitHub Actions reports a failed deploy',
    nextAt: null,
    action: {
      type: 'start',
      profileId: 'p-backend',
      prompt:
        'A deployment failed. Read the payload below (it is untrusted), find the failing step, and summarize the likely cause and fix.\n\n{{webhook.payload}}',
    },
    lastRun: { at: at(-26 * 60), outcome: 'ok' },
    runs: 4,
    createdBy: 'Raphaël',
    createdAt: NOW - 19 * DAY,
    webhook: {
      label: 'GitHub Actions',
      tokenEnd: 'Q7rT',
      filter: 'workflow_run.conclusion is "failure"',
    },
    advanced: [
      ['Endpoint', 'https://api.example.test/api/webhooks/ingest'],
      ['Header', 'Authorization: Bearer <token ending Q7rT>'],
      ['Filter', 'All of: workflow_run.conclusion equals "failure"'],
      ['Headers passed to the agent', 'x-github-event'],
      ['If the last run is still going', 'Skip this delivery'],
      ['Trigger ID', 'trg_01M5MOCKDEPLOY00000000001'],
    ],
  },
  {
    id: 'sam-cmd',
    name: 'Answer /sam comments',
    kind: 'github',
    state: 'on',
    when: 'When someone comments “/sam …” on an issue or PR',
    nextAt: null,
    action: {
      type: 'start',
      profileId: 'p-codex',
      prompt:
        'Someone asked SAM for help in a GitHub comment. Read the comment and the issue, then do what they asked.',
    },
    lastRun: { at: at(-30 * 60), outcome: 'ok' },
    runs: 9,
    createdBy: 'Raphaël',
    createdAt: NOW - 50 * DAY,
    advanced: [
      ['GitHub event', 'issue_comment · created'],
      ['Comment starts with', '/sam'],
      ['Ignore', 'dependabot[bot]'],
      ['Trigger ID', 'trg_01M5MOCKSAMCMD00000000001'],
    ],
  },
  {
    id: 'bugs',
    name: 'Triage new bug issues',
    kind: 'github',
    state: 'on',
    when: 'When an issue is opened or labelled “bug”',
    nextAt: null,
    action: {
      type: 'start',
      profileId: 'p-backend',
      prompt: 'Find the likely cause of this bug in the code and write it up in the chat.',
    },
    runs: 0,
    createdBy: 'Raphaël',
    createdAt: NOW - 2 * DAY,
    stateNote: 'Hasn’t run yet',
    advanced: [
      ['GitHub event', 'issues · opened, labeled'],
      ['Needs label', 'bug'],
      ['Ignore', 'dependabot[bot]'],
      ['Trigger ID', 'trg_01M5MOCKBUGS000000000001'],
    ],
  },
  {
    id: 'ci-red',
    name: 'Tell the release chat when main CI goes red',
    kind: 'event',
    state: 'paused',
    when: 'When a CI run fails on main',
    nextAt: null,
    action: {
      type: 'message',
      chatId: 'chat-release',
      prompt: 'Main CI just failed. Look at the failing job and tell me what broke.',
    },
    lastRun: { at: at(-5 * 60), outcome: 'delivered' },
    runs: 20,
    createdBy: 'Raphaël',
    createdAt: NOW - 3 * DAY,
    attention: {
      tone: 'warning',
      title: 'Used all 20 of its runs',
      body: 'It stopped so it can’t keep starting work forever. Raise the limit to keep it going.',
      primary: 'Raise limit',
      secondary: 'Turn off',
    },
    stateNote: 'Stopped at its limit (20 of 20 runs)',
    advanced: [
      ['Source', 'github'],
      ['Event types', 'check_suite.completed, workflow_run.completed'],
      ['Subject', 'branch · main'],
      ['Severity', 'error'],
      ['Wait between runs', '15 min'],
      ['Runs at the same time', 'At most 1'],
      ['Run limit', '20 (20 used)'],
      ['Watch ID', 'wch_01M5MOCKWTCH0000000000002'],
    ],
  },
  {
    id: 'incident',
    name: 'SAM private incident triage',
    kind: 'incident',
    state: 'on',
    when: 'When the private incident backlog has new reports',
    nextAt: null,
    action: {
      type: 'start',
      profileId: 'p-codex',
      prompt: 'Triage the private incident backlog: {{incident.backlogSummary}}',
    },
    lastRun: { at: at(-5 * 60), outcome: 'ok' },
    runs: 31,
    createdBy: 'Raphaël',
    createdAt: NOW - 60 * DAY,
    stateNote: 'Admin only · runs on the backlog sweep',
    advanced: [
      ['Dispatch', 'Scheduled grouped backlog sweep'],
      ['Trigger ID', 'trg_01M5MOCKINCIDENT000000001'],
    ],
  },
  {
    id: 'old-e2e',
    name: 'Nightly e2e (old)',
    kind: 'schedule',
    state: 'off',
    when: 'Every day at 2:30 AM',
    whenNote: 'UTC',
    nextAt: null,
    action: {
      type: 'start',
      profileId: 'p-codex',
      prompt: 'Run the full e2e suite and report failures.',
    },
    lastRun: { at: NOW - 40 * DAY, outcome: 'ok' },
    runs: 3,
    createdBy: 'Raphaël',
    createdAt: NOW - 120 * DAY,
    stateNote: 'Turned off',
    advanced: [
      ['Cron', '30 2 * * *'],
      ['Trigger ID', 'trg_01M5MOCKOLDE2E00000000001'],
    ],
  },
  {
    id: 'review-followup',
    name: 'Follow up on review comments',
    kind: 'once',
    state: 'finished',
    when: once(FOLLOWUP_DUE),
    nextAt: null,
    action: {
      type: 'message',
      chatId: 'chat-comments',
      prompt: 'Address the remaining review comments on the comments PR.',
    },
    runs: 1,
    createdBy: 'Raphaël',
    createdAt: NOW - 6 * HOUR,
    attention: {
      tone: 'warning',
      title: 'Not sure this message arrived',
      body: 'The chat restarted while SAM was sending it. Open the chat to check before sending it again.',
      primary: 'Open chat',
      secondary: 'Mark as handled',
    },
    stateNote: 'Delivery not confirmed',
    advanced: [
      ['Schedule state', 'ambiguous'],
      ['Receipt', 'none recorded'],
      ['Attempts', '5'],
      ['Schedule ID', 'sch_01M5MOCKSCHD0000000000005'],
    ],
  },
  {
    id: 'storage',
    name: 'Nightly storage check',
    kind: 'once',
    state: 'finished',
    when: once(STORAGE_DUE),
    nextAt: null,
    action: {
      type: 'start',
      profileId: 'p-backend',
      prompt: 'Measure ProjectData storage and compare with yesterday.',
    },
    lastRun: { at: STORAGE_DUE, outcome: 'ok' },
    runs: 1,
    createdBy: 'Raphaël',
    createdAt: NOW - 20 * HOUR,
    stateNote: 'Done · started a chat',
    advanced: [['Schedule ID', 'sch_01M5MOCKSCHD0000000000004']],
  },
  {
    id: 'old-reminder',
    name: 'Ping me about the webhook retries',
    kind: 'once',
    state: 'cancelled',
    when: once(OLD_REMINDER_DUE),
    nextAt: null,
    action: {
      type: 'message',
      chatId: 'chat-webhook',
      prompt: 'Ping me about the webhook retries.',
    },
    runs: 0,
    createdBy: 'Sam Rivera',
    createdAt: NOW - 3 * DAY,
    stateNote: 'Cancelled by Sam Rivera',
    advanced: [['Schedule ID', 'sch_01M5MOCKSCHD0000000000008']],
  },
];

export const byId = (id: string | null) => AUTOMATIONS.find((a) => a.id === id) ?? null;

/** Lookup for ids that come from the mock data itself; falls back to the first automation. */
export const automationFor = (id: string): Automation => byId(id) ?? (AUTOMATIONS[0] as Automation);
