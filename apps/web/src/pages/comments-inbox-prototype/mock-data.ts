/**
 * Mock data for the comments inbox prototype (dev-only route `/prototype/comments-inbox`).
 *
 * Shaped like production comment threads, but with the context the redesign needs and the
 * API does not return today: the text of the commented message (or file) around the quote.
 * Stress cases on purpose: a long chat title, a long author name, multi-paragraph bodies,
 * inline code, an unbroken URL, emoji and CJK, a chat the viewer does not control, a file.
 */

export type PersonKind = 'human' | 'agent';

export interface Person {
  id: string;
  name: string;
  kind: PersonKind;
}

export const ME: Person = { id: 'me', name: 'Raphaël Titsworth-Morin', kind: 'human' };
export const AGENT: Person = { id: 'agent', name: 'SAM agent', kind: 'agent' };
const DANA: Person = { id: 'dana', name: 'Dana Okonkwo', kind: 'human' };
const PRAKASH: Person = { id: 'prakash', name: 'Prakash Rao', kind: 'human' };
const ALEXANDRA: Person = {
  id: 'alexandra',
  name: 'Alexandra Konstantinopoulou-Whitfield',
  kind: 'human',
};

export interface CommentEntry {
  id: string;
  author: Person;
  body: string;
  at: number;
  mentionsMe?: boolean;
  /** This entry was sent to the agent as a message. */
  sentToAgent?: boolean;
}

export type ChatState = 'working' | 'idle' | 'sleeping';

export type CommentSource =
  | {
      kind: 'chat';
      chatId: string;
      chatTitle: string;
      chatState: ChatState;
      ownerName: string;
      /** Owner or shared with the viewer: may send comments to this chat's agent. */
      youControl: boolean;
      message: { by: 'agent' | 'owner' | 'teammate'; byName?: string; at: number; text: string };
    }
  | {
      kind: 'file';
      fileId: string;
      fileName: string;
      folder: string;
      text: string;
    };

export type ThreadStatus = 'open' | 'sent' | 'resolved';

export interface InboxItem {
  id: string;
  source: CommentSource;
  /** The selected passage. Null for a comment on the whole message or file. */
  quote: string | null;
  status: ThreadStatus;
  /** Root comment first, then replies. */
  entries: CommentEntry[];
}

const NOW = Date.now();
const min = (n: number) => NOW - n * 60_000;
const hour = (n: number) => min(n * 60);
const day = (n: number) => hour(n * 24);

const WEBHOOK_CHAT = {
  chatId: 'chat-webhook',
  chatTitle:
    'Harden webhook retry policy and Stripe idempotency keys before the Q4 billing migration',
  chatState: 'idle' as const,
  ownerName: 'You',
  youControl: true,
};

const WEBHOOK_MESSAGE = {
  by: 'agent' as const,
  at: hour(2),
  text: [
    'I looked at how we answer Stripe when the same webhook arrives twice. Right now a duplicate delivery hits the unique index on `stripe_event_id` and we return 409.',
    'Stripe treats anything other than 2xx as a failure, so a 409 makes it retry with exponential backoff for up to 3 days. Every retry hits the same index and fails the same way.',
    'I recommend returning 200 with a structured log line for duplicates, because a 409 just generates retries that will all conflict again. The handler stays idempotent either way: the insert is still guarded by the index.',
    'Next steps:\n1. Return 200 and log `duplicate_event` for unique-index conflicts.\n2. Keep 409 for real conflicts (same event id, different amount).\n3. Add a test that replays the same event three times.',
  ].join('\n\n'),
};

export const INBOX_ITEMS: InboxItem[] = [
  {
    id: 'c-dana-mention',
    source: { kind: 'chat', ...WEBHOOK_CHAT, message: WEBHOOK_MESSAGE },
    quote: 'I recommend returning 200 with a structured log line for duplicates',
    status: 'open',
    entries: [
      {
        id: 'e1',
        author: DANA,
        at: min(12),
        mentionsMe: true,
        body: '@Raphaël is 200 right here? Our payments runbook says a duplicate with a different amount must page someone.\n\nCan we keep 409 for that case and return 200 only for exact replays?',
      },
    ],
  },
  {
    id: 'c-agent-reply',
    source: {
      kind: 'chat',
      chatId: 'chat-wake',
      chatTitle: 'Session wake: recovery_attempts never resets after a successful wake',
      chatState: 'working',
      ownerName: 'You',
      youControl: true,
      message: {
        by: 'agent',
        at: hour(3),
        text: "Found it. `recovery_attempts` is a lifetime counter: it only ever increments, so after three wakes in a session's life the fourth wake is refused even if the first three succeeded.\n\nThe fix is to reset it on both success paths (normal wake and restore from snapshot), the same way `sleepAttempts` is reset.",
      },
    },
    quote:
      "it only ever increments, so after three wakes in a session's life the fourth wake is refused",
    status: 'sent',
    entries: [
      {
        id: 'e1',
        author: ME,
        at: min(48),
        sentToAgent: true,
        body: 'Does this also explain the chat that stayed asleep yesterday after I replied to it?',
      },
      {
        id: 'e2',
        author: AGENT,
        at: min(6),
        body: 'Yes, most likely. That chat had three earlier wakes.\n\nFixed in `a3f9c21`:\n- reset on normal wake\n- reset on restore from snapshot\n- new test: four wakes in a row all succeed\n\nThe old value is still logged as `lifetime_recovery_attempts`.',
      },
    ],
  },
  {
    id: 'c-prakash-plan',
    source: {
      kind: 'chat',
      chatId: 'chat-storage',
      chatTitle: 'Plan: move comment storage into its own tables',
      chatState: 'sleeping',
      ownerName: 'You',
      youControl: true,
      message: {
        by: 'agent',
        at: hour(5),
        text: 'Here is the plan.\n\n1. Add `comment_threads_v2` and `comment_replies_v2` next to the current tables.\n2. In one alarm tick, copy every thread and reply across, assigning new IDs.\n3. Switch reads to the new tables, then drop the old ones in a later release.\n\nThe copy is a single transaction, so a failure leaves the old tables untouched.',
      },
    },
    quote: null,
    status: 'open',
    entries: [
      {
        id: 'e1',
        author: PRAKASH,
        at: min(40),
        body: 'Two concerns before you send this to the agent:\n\n1. Copying every thread in one alarm tick will time out on big projects.\n2. New IDs break every comment link in existing notifications.\n\nCould it copy in batches and keep the old IDs?',
      },
    ],
  },
  {
    id: 'c-file-dana',
    source: {
      kind: 'file',
      fileId: 'file-retention',
      fileName: 'retention-design.md',
      folder: '/engineering/research/',
      text: 'Retention\n\nWorkspaces that sleep keep a snapshot so they can wake exactly where they left off. Snapshots older than 30 days are deleted. Chat transcripts are kept until the chat is archived.\n\nOpen question: should projects be able to choose their own window?',
    },
    quote: 'Snapshots older than 30 days are deleted.',
    status: 'open',
    entries: [
      {
        id: 'e1',
        author: DANA,
        at: hour(1),
        body: 'Where does the 30-day number come from? Legal asked for 90 days for anything that touches billing.',
      },
    ],
  },
  {
    id: 'c-prakash-chat',
    source: {
      kind: 'chat',
      chatId: 'chat-list-speed',
      chatTitle: 'Speed up the chat list on slow phones',
      chatState: 'idle',
      ownerName: 'Prakash Rao',
      youControl: false,
      message: {
        by: 'agent',
        at: day(1),
        text: 'The list re-renders every row on each poll. With virtualization and a stable row key, we can drop the 24h transcript cache entirely and still open chats instantly on a mid-range Android phone.',
      },
    },
    quote: 'we can drop the 24h transcript cache entirely',
    status: 'open',
    entries: [
      {
        id: 'e1',
        author: PRAKASH,
        at: min(30),
        mentionsMe: true,
        body: '@Raphaël you built that cache. Is it safe to drop?',
      },
    ],
  },
  {
    id: 'c-alexandra',
    source: {
      kind: 'chat',
      chatId: 'chat-hero',
      chatTitle: 'Marketing site: hero copy',
      chatState: 'idle',
      ownerName: 'You',
      youControl: true,
      message: {
        by: 'agent',
        at: hour(7),
        text: 'Draft hero line: "Run a fleet of coding agents on your own cloud." Subline: "Every agent gets its own workspace, and you see everything from your phone."',
      },
    },
    quote: 'Run a fleet of coding agents on your own cloud.',
    status: 'open',
    entries: [
      {
        id: 'e1',
        author: ALEXANDRA,
        at: hour(4),
        body: 'Love it 👍 The Japanese page should keep the same promise: 明確に違う。 Reference: https://example.com/a/very/long/unbroken/url/that/cannot/wrap/anywhere/at/all/really',
      },
    ],
  },
  {
    id: 'c-waiting',
    source: { kind: 'chat', ...WEBHOOK_CHAT, message: WEBHOOK_MESSAGE },
    quote: 'Add a test that replays the same event three times.',
    status: 'sent',
    entries: [
      {
        id: 'e1',
        author: ME,
        at: min(3),
        sentToAgent: true,
        body: 'Also replay them out of order (event 2 before event 1).',
      },
    ],
  },
  {
    id: 'c-note',
    source: {
      kind: 'chat',
      chatId: 'chat-docs',
      chatTitle: 'Weekly docs pass: collaboration guide',
      chatState: 'sleeping',
      ownerName: 'You',
      youControl: true,
      message: {
        by: 'agent',
        at: day(1),
        text: 'Updated the collaboration guide with screenshots of the comment rail and the share dialog.',
      },
    },
    quote: null,
    status: 'open',
    entries: [
      {
        id: 'e1',
        author: ME,
        at: day(1),
        body: 'Revisit after the comments redesign: these screenshots will be out of date.',
      },
    ],
  },
  {
    id: 'c-resolved-1',
    source: {
      kind: 'chat',
      chatId: 'chat-inbox',
      chatTitle: 'Comment inbox wording',
      chatState: 'sleeping',
      ownerName: 'You',
      youControl: true,
      message: {
        by: 'agent',
        at: day(2),
        text: 'Buckets are Needs you, With agent, Open and Resolved.',
      },
    },
    quote: 'With agent',
    status: 'resolved',
    entries: [
      { id: 'e1', author: ME, at: day(2), body: 'Say "Waiting on agent" instead.' },
      { id: 'e2', author: AGENT, at: day(2), body: 'Done.' },
    ],
  },
  {
    id: 'c-resolved-2',
    source: {
      kind: 'file',
      fileId: 'file-onboarding',
      fileName: 'onboarding-flow.md',
      folder: '/design/',
      text: 'Step 3 asks for a Hetzner token before the user has seen anything work.',
    },
    quote: 'Step 3 asks for a Hetzner token',
    status: 'resolved',
    entries: [
      {
        id: 'e1',
        author: DANA,
        at: day(3),
        body: 'Platform credentials make this step optional now.',
      },
    ],
  },
];
