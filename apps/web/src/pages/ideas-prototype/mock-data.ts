/**
 * Mock data for the Ideas redesign prototype (throwaway; never merge to main).
 *
 * One fictional project (Northwind Labs / Payments API, the same world as the marketing
 * screenshots). The story follows one idea, "Retry failed webhook deliveries", from
 * Not started to Done. Other ideas exist to fill the list with realistic variety and
 * stress cases (long titles, emoji, many items).
 */

/** Where an idea stands. Derived from the work linked to it, except Done and Parked. */
export type IdeaState =
  | 'not-started'
  | 'working'
  | 'review'
  | 'merged'
  | 'stuck'
  | 'question'
  | 'done'
  | 'parked';

export type Tone = 'danger' | 'warning' | 'info';

export interface Attention {
  tone: Tone;
  /** What happened, in one line. */
  title: string;
  body: string;
  primary: string;
  secondary?: string;
}

export interface IdeaRowData {
  id: string;
  title: string;
  state: IdeaState;
  /** One line under the title: a summary, or what is happening right now. */
  line: string;
  /** Small counts: updates, chats, files. */
  meta?: string;
  attention?: Attention;
}

export interface WorkItem {
  id: string;
  kind: 'chat' | 'pr';
  title: string;
  who: string;
  outcome: string;
  tone: 'live' | 'ok' | 'muted' | 'review';
  when: string;
  diff?: string;
}

export interface UpdateItem {
  id: string;
  author: string;
  authorKind: 'human' | 'agent';
  when: string;
  text: string;
  kind: 'note' | 'research' | 'created' | 'started' | 'pr' | 'merged' | 'done';
  quote?: string;
  file?: string;
  instruction?: string;
}

export interface RelatedItem {
  id: string;
  kind: 'file' | 'idea' | 'pr';
  title: string;
  note: string;
}

export interface IdeaPageData {
  title: string;
  state: IdeaState;
  statusLine: string;
  statusDetail: string;
  primaryAction: string;
  secondaryAction?: string;
  text: string;
  editedNote: string;
  work: WorkItem[];
  updates: UpdateItem[];
  related: RelatedItem[];
}

// ---------------------------------------------------------------------------
// The idea the story follows
// ---------------------------------------------------------------------------

export const STORY_IDEA_TITLE = 'Retry failed webhook deliveries';

const STORY_TEXT = `When a merchant's endpoint is down, we drop the webhook after one failed attempt. Merchants miss \`charge.succeeded\` and ship orders late.

**What we want**
- Retry failed deliveries with exponential backoff for up to 3 days, the same window Stripe uses.
- Show every attempt in the dashboard's delivery log.
- After the last attempt, park the event so the merchant can replay it.

**Out of scope:** the refunds webhook path (separate service).`;

const BASE_UPDATES: UpdateItem[] = [
  {
    id: 'u-marcus',
    author: 'Marcus Chen',
    authorKind: 'human',
    when: '2d',
    kind: 'note',
    quote: 'cap retries at 5 attempts',
    text: 'Stripe gives up after 3 days, not after 5 attempts. Match that, so merchants see the same behaviour from both.',
  },
  {
    id: 'u-research',
    author: 'Brainstormer',
    authorKind: 'agent',
    when: '5d',
    kind: 'research',
    text: 'Compared how Stripe and Adyen retry webhooks. Recommendation: exponential backoff over 3 days, then park the event for a manual replay.',
    file: 'retry-schedules.md',
  },
  {
    id: 'u-you',
    author: 'You',
    authorKind: 'human',
    when: '6d',
    kind: 'note',
    text: 'Pro-plan merchants are the loudest about this. If we stage it, start with them.',
  },
  {
    id: 'u-created',
    author: 'Opus 5.5',
    authorKind: 'agent',
    when: '9d',
    kind: 'created',
    text: 'Created this idea from the chat “Webhook failures in prod”.',
  },
];

const BASE_WORK: WorkItem[] = [
  {
    id: 'w-research',
    kind: 'chat',
    title: 'How do Stripe and Adyen retry webhooks?',
    who: 'Brainstormer',
    outcome: 'Talked it through',
    tone: 'muted',
    when: '5d',
  },
  {
    id: 'w-origin',
    kind: 'chat',
    title: 'Webhook failures in prod',
    who: 'You with Opus 5.5',
    outcome: 'Idea created here',
    tone: 'muted',
    when: '9d',
  },
];

const RELATED: RelatedItem[] = [
  {
    id: 'r-file',
    kind: 'file',
    title: 'retry-schedules.md',
    note: 'Added by Brainstormer while researching',
  },
  {
    id: 'r-idea',
    kind: 'idea',
    title: 'Alert when webhook failures spike',
    note: 'Idea · Not started',
  },
  {
    id: 'r-pr',
    kind: 'pr',
    title: 'PR #431 Log every webhook delivery attempt',
    note: 'Merged in September · groundwork',
  },
];

const WORKING_CHAT: WorkItem = {
  id: 'w-build',
  kind: 'chat',
  title: 'Retry failed webhook deliveries',
  who: 'Opus 5.5 · do skill',
  outcome: 'Working now',
  tone: 'live',
  when: 'now',
};

const STARTED_UPDATE: UpdateItem = {
  id: 'u-started',
  author: 'You',
  authorKind: 'human',
  when: '2m',
  kind: 'started',
  text: 'Started work with Opus 5.5, using the do skill.',
  instruction: 'Match the 3-day window. Leave the refunds path alone.',
};

const PR_ITEM: WorkItem = {
  id: 'w-pr',
  kind: 'pr',
  title: 'PR #482 Retry failed webhook deliveries with backoff',
  who: 'Opus 5.5',
  outcome: 'Open · 3 checks passed',
  tone: 'review',
  when: '1h',
  diff: '+412 −38',
};

const PR_UPDATE: UpdateItem = {
  id: 'u-pr',
  author: 'Opus 5.5',
  authorKind: 'agent',
  when: '1h',
  kind: 'pr',
  text: 'Opened PR #482. Retries back off from 1 minute to 12 hours across 3 days. Parked events can be replayed from the delivery log.',
};

export const STORY_IDEA: Record<'not-started' | 'working' | 'review' | 'done', IdeaPageData> = {
  'not-started': {
    title: STORY_IDEA_TITLE,
    state: 'not-started',
    statusLine: 'Not started',
    statusDetail: '4 updates · 2 chats · 1 file',
    primaryAction: 'Start work',
    text: STORY_TEXT,
    editedNote: 'Edited 2d ago by Brainstormer',
    work: BASE_WORK,
    updates: BASE_UPDATES,
    related: RELATED,
  },
  working: {
    title: STORY_IDEA_TITLE,
    state: 'working',
    statusLine: 'In progress',
    statusDetail: 'Opus 5.5 is working · started 2 min ago',
    primaryAction: 'Open the chat',
    text: STORY_TEXT,
    editedNote: 'Edited 2d ago by Brainstormer',
    work: [WORKING_CHAT, ...BASE_WORK],
    updates: [STARTED_UPDATE, ...BASE_UPDATES],
    related: RELATED,
  },
  review: {
    title: STORY_IDEA_TITLE,
    state: 'review',
    statusLine: 'In review',
    statusDetail: 'PR #482 is open · 3 checks passed',
    primaryAction: 'Review PR #482',
    secondaryAction: 'Open the chat',
    text: STORY_TEXT,
    editedNote: 'Edited 2d ago by Brainstormer',
    work: [
      PR_ITEM,
      { ...WORKING_CHAT, outcome: 'Opened PR #482', tone: 'ok', when: '1h' },
      ...BASE_WORK,
    ],
    updates: [PR_UPDATE, { ...STARTED_UPDATE, when: '3h' }, ...BASE_UPDATES],
    related: RELATED,
  },
  done: {
    title: STORY_IDEA_TITLE,
    state: 'done',
    statusLine: 'Done',
    statusDetail: 'Shipped in PR #482 · Oct 25',
    primaryAction: 'Start follow-up work',
    text: STORY_TEXT,
    editedNote: 'Edited 2d ago by Brainstormer',
    work: [
      { ...PR_ITEM, outcome: 'Merged', tone: 'ok', when: '1h' },
      { ...WORKING_CHAT, outcome: 'Opened PR #482', tone: 'ok', when: '1d' },
      ...BASE_WORK,
    ],
    updates: [
      {
        id: 'u-done',
        author: 'You',
        authorKind: 'human',
        when: 'now',
        kind: 'done',
        text: 'Marked done.',
      },
      {
        id: 'u-merged',
        author: 'GitHub',
        authorKind: 'agent',
        when: '1h',
        kind: 'merged',
        text: 'PR #482 was merged by Marcus Chen.',
      },
      { ...PR_UPDATE, when: '1d' },
      { ...STARTED_UPDATE, when: '1d' },
      ...BASE_UPDATES,
    ],
    related: RELATED,
  },
};

// ---------------------------------------------------------------------------
// The Ideas list
// ---------------------------------------------------------------------------

const RATE_LIMIT_MERGED: IdeaRowData = {
  id: 'i-rate-limit',
  title: 'Rate-limit the public API',
  state: 'merged',
  line: 'PR #476 merged yesterday',
  attention: {
    tone: 'info',
    title: 'PR #476 was merged yesterday. Is this idea done?',
    body: 'Limits are live for /v1/charges and /v1/refunds. The docs page was not part of the PR.',
    primary: 'Mark done',
    secondary: 'Keep open',
  },
};

const STRIPE_ATTENTION: Attention = {
  tone: 'danger',
  title: 'Work stopped: 3 tests failed in refunds.test.ts',
  body: 'Codex 5.5 High could not make v15’s new refund types pass. Its chat has the details.',
  primary: 'See what happened',
  secondary: 'Try again',
};

const STRIPE_STUCK: IdeaRowData = {
  id: 'i-stripe',
  title: 'Upgrade the Stripe SDK to v15',
  state: 'stuck',
  line: 'Work stopped: 3 tests failed',
  attention: STRIPE_ATTENTION,
};

const INVOICE_QUESTION: IdeaRowData = {
  id: 'i-invoices',
  title: 'Split invoices by currency',
  state: 'question',
  line: 'Codex 5.5 High is waiting for your answer',
  attention: {
    tone: 'warning',
    title: 'Codex 5.5 High is asking you something',
    body: '“For partial refunds across two currencies, should I round half-up or to even?”',
    primary: 'Answer',
  },
};

const STORY_MERGED: IdeaRowData = {
  id: 'i-webhooks',
  title: STORY_IDEA_TITLE,
  state: 'merged',
  line: 'PR #482 merged an hour ago',
  attention: {
    tone: 'info',
    title: 'PR #482 was merged an hour ago. Is this idea done?',
    body: 'Opus 5.5 built retries with a 3-day window and replay from the delivery log, as the idea asked.',
    primary: 'Mark done',
    secondary: 'Keep open',
  },
};

const IN_PROGRESS: IdeaRowData[] = [
  {
    id: 'i-idempotency',
    title: 'Idempotency keys for POST /charges',
    state: 'working',
    line: 'Opus 5.5 is working · started 14 min ago',
    meta: '6 updates · 3 chats',
  },
  {
    id: 'i-replica',
    title: 'Move ledger reads to the read replica',
    state: 'review',
    line: 'In review · PR #479 · 3 checks passed',
    meta: '3 updates · 1 chat',
  },
];

const STORY_NOT_STARTED: IdeaRowData = {
  id: 'i-webhooks',
  title: STORY_IDEA_TITLE,
  state: 'not-started',
  line: 'Researched: Stripe and Adyen retry schedules compared',
  meta: '4 updates · 2 chats · 1 file',
};

const OTHER_NOT_STARTED: IdeaRowData[] = [
  {
    id: 'i-alert',
    title: 'Alert when webhook failures spike',
    state: 'not-started',
    line: 'Page on-call when failures pass 5% for 10 minutes',
    meta: '2 updates',
  },
  {
    id: 'i-dry-run',
    title: 'Add a dry-run mode to the nightly payout job',
    state: 'not-started',
    line: 'Print what would be paid out, without moving money',
    meta: '1 update · 1 chat',
  },
  {
    id: 'i-receipts',
    title:
      'Customer-facing receipt PDFs in 9 languages, including right-to-left scripts (Arabic, Hebrew), CJK fonts and per-merchant branding',
    state: 'not-started',
    line: 'Needs a font strategy first; Noto covers most of it',
    meta: '5 updates · 2 chats · 3 files',
  },
  {
    id: 'i-wallets',
    title: 'Support Apple Pay & Google Pay in checkout 💳',
    state: 'not-started',
    line: 'Merchants on the Pro plan asked for this twice in October',
    meta: '1 update',
  },
  {
    id: 'i-flags',
    title: 'Clean up the feature flags left from the Q2 pricing test',
    state: 'not-started',
    line: '11 flags are still read in code; 4 are always on',
  },
  {
    id: 'i-declines',
    title: 'Explain declined cards to customers in plain words',
    state: 'not-started',
    line: 'Map the 40 decline codes to 8 messages people understand',
    meta: '2 updates · 1 chat',
  },
  {
    id: 'i-recon',
    title: 'Nightly reconciliation report for finance',
    state: 'not-started',
    line: 'CSV in the shared drive by 6am, totals per currency',
  },
];

export const DONE_RECENTLY: IdeaRowData[] = [
  {
    id: 'd-1',
    title: 'Show refund status on the order page',
    state: 'done',
    line: 'Shipped in PR #470 · Oct 18',
  },
  {
    id: 'd-2',
    title: 'Faster test suite: run the payment tests in parallel',
    state: 'done',
    line: 'Shipped in PR #466 · Oct 15',
  },
  {
    id: 'd-3',
    title: 'Drop the unused v1 currency table',
    state: 'done',
    line: 'Shipped in PR #461 · Oct 11',
  },
];

export const FILED_BY_AGENTS = {
  count: 14,
  newest: 'Recurring 502 from /v1/charges: 12 times this week',
};

export interface ListScene {
  needsYou: IdeaRowData[];
  inProgress: IdeaRowData[];
  notStarted: IdeaRowData[];
  doneCount: number;
}

/** The list the first time you open it in the story. */
export const LIST_START: ListScene = {
  needsYou: [STRIPE_STUCK, INVOICE_QUESTION, RATE_LIMIT_MERGED],
  inProgress: IN_PROGRESS,
  notStarted: [STORY_NOT_STARTED, ...OTHER_NOT_STARTED],
  doneCount: 6,
};

/** The list a day later: the story idea's PR merged, so it asks you to call it done. */
export const LIST_MERGED: ListScene = {
  needsYou: [STORY_MERGED, STRIPE_STUCK, INVOICE_QUESTION],
  inProgress: IN_PROGRESS,
  notStarted: OTHER_NOT_STARTED,
  doneCount: 7,
};

// ---------------------------------------------------------------------------
// Start work
// ---------------------------------------------------------------------------

export interface ProfileChoice {
  id: string;
  name: string;
  description: string;
  canChangeCode: boolean;
}

export const OPUS: ProfileChoice = {
  id: 'opus',
  name: 'Opus 5.5',
  description: 'Plans and builds carefully, opens a pull request',
  canChangeCode: true,
};

export const BRAINSTORMER: ProfileChoice = {
  id: 'brainstormer',
  name: 'Brainstormer',
  description: 'Talks it through with you. Cannot change code.',
  canChangeCode: false,
};

export interface SkillChoice {
  id: string;
  name: string;
  description: string;
}

export const DO_SKILL: SkillChoice = {
  id: 'do',
  name: 'do',
  description: 'Plan, build, test and open a pull request',
};

export const START_NOTE = 'Match the 3-day window. Leave the refunds path alone.';

/** What the agent receives without anyone pasting it into a prompt. */
export const CONTEXT_ITEMS = ['The idea', '4 updates', 'retry-schedules.md', '2 earlier chats'];

// ---------------------------------------------------------------------------
// Stress and empty scenes (not part of the story; they check the layout holds)
// ---------------------------------------------------------------------------

const STRESS_ROWS: IdeaRowData[] = [
  {
    id: 's-unbroken',
    title: 'x'.repeat(220),
    state: 'not-started',
    line: `https://example.com/${'very-long-path-segment-'.repeat(10)}`,
    meta: '12 updates · 9 chats · 31 files',
  },
  {
    id: 's-html',
    title: 'Fix: <script>alert("xss")</script> & “quotes” 日本語テスト 🚀',
    state: 'not-started',
    line: '&amp; &lt; &gt; should show as typed',
  },
  { id: 's-a', title: 'A', state: 'not-started', line: 'B' },
  ...Array.from({ length: 30 }, (_, index): IdeaRowData => ({
    id: `s-gen-${index}`,
    title: `Generated idea ${index + 1}: ${['Refactor the ledger', 'Add tests for payouts', 'Speed up CI', 'Document the API', 'Fix a flaky test'][index % 5]}`,
    state: 'not-started',
    line: index % 3 === 0 ? 'A short summary line' : 'A longer summary line that wraps onto a second line on a phone screen',
    meta: index % 2 === 0 ? `${index} updates · ${index % 4} chats` : undefined,
  })),
];

export const LIST_STRESS: ListScene = {
  needsYou: [
    {
      ...STRIPE_STUCK,
      title: `${'Upgrade the Stripe SDK '.repeat(8)}to v15`,
      attention: {
        ...STRIPE_ATTENTION,
        body: `Codex 5.5 High could not make the tests pass: ${'refunds.test.ts › partial refunds across currencies › '.repeat(4)}`,
      },
    },
    INVOICE_QUESTION,
  ],
  inProgress: IN_PROGRESS,
  notStarted: STRESS_ROWS,
  doneCount: 128,
};

export const LIST_EMPTY: ListScene = { needsYou: [], inProgress: [], notStarted: [], doneCount: 0 };
