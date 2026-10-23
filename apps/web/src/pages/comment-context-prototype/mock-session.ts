/**
 * Mock transcripts and comment threads for the comment-context prototype
 * (dev-only route `/prototype/comment-context`).
 *
 * The transcripts are real `DisplayItem`s, so the prototype renders them with the production
 * chat components. Threads anchor to a message id plus the quoted passage, which is what the
 * API stores today. One quote sits near the end of a long message on purpose: landing on the
 * message is not enough, the reader has to land on the passage.
 */
import type { ToolCallItem } from '@simple-agent-manager/acp-client';

import type {
  DisplayItem,
  ToolCallGroupItem,
} from '../../components/project-message-view/tool-call-groups';
import { AGENT, type CommentEntry, ME, type Person } from '../comments-inbox-prototype/mock-data';

const DANA: Person = { id: 'dana', name: 'Dana Okonkwo', kind: 'human' };
const PRAKASH: Person = { id: 'prakash', name: 'Prakash Rao', kind: 'human' };

const NOW = Date.now();
const min = (n: number) => NOW - n * 60_000;

function user(id: string, at: number, text: string): DisplayItem {
  return { kind: 'user_message', id, text, timestamp: at };
}

function agent(id: string, at: number, text: string): DisplayItem {
  return { kind: 'agent_message', id, text, streaming: false, timestamp: at };
}

function tools(id: string, at: number, titles: string[]): ToolCallGroupItem {
  const items: ToolCallItem[] = titles.map((title, index) => ({
    kind: 'tool_call',
    id: `${id}-${index}`,
    toolCallId: `${id}-call-${index}`,
    title,
    status: 'completed',
    content: [],
    locations: [],
    timestamp: at + index * 1000,
  }));
  return { kind: 'tool_call_group', id, items, timestamp: at };
}

export interface ChatSession {
  id: string;
  title: string;
  ownerName: string;
  youControl: boolean;
  state: 'Idle' | 'Agent working' | 'Asleep';
  items: DisplayItem[];
}

export const WEBHOOK_CHAT: ChatSession = {
  id: 'chat-webhook',
  title: 'Harden webhook retry policy and Stripe idempotency keys before the Q4 billing migration',
  ownerName: 'You',
  youControl: true,
  state: 'Idle',
  items: [
    user(
      'm01',
      min(190),
      "Our Stripe webhook handler keeps getting retried for days. Look at how we handle duplicate deliveries and propose a fix. Don't change anything yet."
    ),
    tools('m02', min(189), [
      'Read apps/api/src/routes/stripe-webhook.ts',
      'Search for "stripe_event_id"',
      'Read migrations/0142_stripe_events.sql',
      'Read services/billing/ledger.ts',
      'Run pnpm test stripe-webhook',
    ]),
    agent(
      'm03',
      min(186),
      'Here is what happens today when Stripe calls us:\n\n1. We verify the signature.\n2. We write the payment to the ledger.\n3. We insert the event into `stripe_events`, which has a unique index on `stripe_event_id`.\n4. We return 200.\n\nWhen the same event arrives twice, step 3 fails on the unique index and the handler returns 409.'
    ),
    tools('m04', min(185), [
      'Search for "409"',
      'Read tests/stripe-webhook.test.ts',
      'Read docs/runbooks/payments.md',
    ]),
    agent(
      'm05',
      min(182),
      'I looked at how we answer Stripe when the same webhook arrives twice. Right now a duplicate delivery hits the unique index on `stripe_event_id` and we return 409.\n\nStripe treats anything other than 2xx as a failure, so a 409 makes it retry with exponential backoff for up to 3 days. Every retry hits the same index and fails the same way.\n\nI recommend returning 200 with a structured log line for duplicates, because a 409 just generates retries that will all conflict again. The handler stays idempotent either way: the insert is still guarded by the index.\n\n**Next steps**\n1. Return 200 and log `duplicate_event` for unique-index conflicts.\n2. Keep 409 for real conflicts (same event id, different amount).\n3. Add a test that replays the same event three times.'
    ),
    user('m06', min(150), 'Go ahead with 1 and 3. Keep 409 for amount mismatches.'),
    tools('m07', min(149), [
      'Edit apps/api/src/routes/stripe-webhook.ts',
      'Edit apps/api/src/services/billing/stripe-events.ts',
      'Edit tests/stripe-webhook.test.ts',
      'Run pnpm test stripe-webhook',
      'Edit tests/stripe-webhook.test.ts',
      'Run pnpm test stripe-webhook',
      'Run pnpm typecheck',
      'Run pnpm lint',
    ]),
    agent(
      'm08',
      min(140),
      "Done. Here is what changed.\n\n**Handler.** `handleStripeEvent()` now catches the unique-index conflict and answers 200:\n\n```ts\nif (isUniqueViolation(err) && sameAmount(existing, event)) {\n  log.info('stripe.duplicate_event', { eventId: event.id });\n  return c.json({ received: true }, 200);\n}\n```\n\n**Amount mismatches.** A duplicate event id with a different amount still returns 409 and logs `stripe.duplicate_mismatch` at error level, so the payments alert fires.\n\n**Tests.** Three new tests: the same event three times in a row, a mismatched amount, and a duplicate after the first insert failed halfway. All 41 webhook tests pass.\n\n**Not changed.** The retry schedule, signature verification and the ledger code are untouched.\n\nOne thing to watch: the ledger write happens before the event row insert, so a crash between the two can double-count a payment on retry. I would move the insert first, inside the same transaction, in a follow-up."
    ),
    user('m09', min(120), 'Good catch. Do the ordering fix now too.'),
    tools('m10', min(119), [
      'Edit apps/api/src/routes/stripe-webhook.ts',
      'Edit apps/api/src/services/billing/ledger.ts',
      'Run pnpm test billing',
      'Run pnpm test stripe-webhook',
    ]),
    agent(
      'm11',
      min(110),
      'Moved the event-row insert before the ledger write, inside one transaction. If the ledger write fails, the event row rolls back with it, so a retry starts clean. Added a test that kills the handler between the two writes.'
    ),
    user('m12', min(90), 'Deploy to staging and replay the last 50 events.'),
    tools('m13', min(89), [
      'Run gh workflow run deploy-staging.yml',
      'Wait for Deploy Staging',
      'Run scripts/replay-stripe-events.ts --last 50',
      'Query the staging ledger',
    ]),
    agent(
      'm14',
      min(70),
      'Staging is on the new build. I replayed the last 50 events twice each: 100 deliveries, 100 × 200, and the ledger shows 50 payments with no duplicates. The mismatch alert fired once, for the test event I sent with a changed amount.'
    ),
    user('m15', min(60), 'Great. Open a PR.'),
    tools('m16', min(59), ['Run git push', 'Create pull request']),
    agent(
      'm17',
      min(55),
      'Opened PR #2431, "Answer duplicate Stripe webhooks with 200 and insert events before the ledger write". CI is running.'
    ),
  ],
};

export const WAKE_CHAT: ChatSession = {
  id: 'chat-wake',
  title: 'Session wake: recovery_attempts never resets after a successful wake',
  ownerName: 'You',
  youControl: true,
  state: 'Agent working',
  items: [
    user(
      'w01',
      min(200),
      'A chat stayed asleep yesterday after I replied to it. Find out why the wake was refused.'
    ),
    tools('w02', min(199), [
      'Search for "recovery_attempts"',
      'Read apps/api/src/durable-objects/project-data/session-wake.ts',
      'Read the wake logs for chat 0c10659f',
    ]),
    agent(
      'w03',
      min(180),
      "Found it. `recovery_attempts` is a lifetime counter: it only ever increments, so after three wakes in a session's life the fourth wake is refused even if the first three succeeded.\n\nThe fix is to reset it on both success paths (normal wake and restore from snapshot), the same way `sleepAttempts` is reset."
    ),
    user('w04', min(170), 'Fix it and add a test.'),
    tools('w05', min(169), [
      'Edit session-wake.ts',
      'Edit session-wake.test.ts',
      'Run pnpm test session-wake',
    ]),
    agent(
      'w06',
      min(160),
      'Fixed and tested: four wakes in a row now all succeed. The old value is still logged as `lifetime_recovery_attempts` for debugging.'
    ),
  ],
};

export const SESSIONS: Record<string, ChatSession> = {
  [WEBHOOK_CHAT.id]: WEBHOOK_CHAT,
  [WAKE_CHAT.id]: WAKE_CHAT,
};

export interface ContextThread {
  id: string;
  sessionId: string;
  /** The message the comment is on, and the exact passage that was selected. */
  anchorId: string;
  quote: string;
  status: 'open' | 'sent' | 'resolved';
  entries: CommentEntry[];
  /** Notification-style line: who did what. */
  reason: { actor: string; verb: string };
  needsYou: boolean;
}

export const THREADS: ContextThread[] = [
  {
    id: 't-dana',
    sessionId: WEBHOOK_CHAT.id,
    anchorId: 'm05',
    quote: 'I recommend returning 200 with a structured log line for duplicates',
    status: 'open',
    reason: { actor: 'Dana Okonkwo', verb: 'mentioned you' },
    needsYou: true,
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
    id: 't-prakash',
    sessionId: WEBHOOK_CHAT.id,
    anchorId: 'm08',
    quote:
      'the ledger write happens before the event row insert, so a crash between the two can double-count a payment on retry',
    status: 'open',
    reason: { actor: 'Prakash Rao', verb: 'commented on your chat' },
    needsYou: true,
    entries: [
      {
        id: 'e1',
        author: PRAKASH,
        at: min(40),
        body: 'This should block the billing migration until the ordering fix ships. Is it fixed by the later commit?',
      },
    ],
  },
  {
    id: 't-agent',
    sessionId: WAKE_CHAT.id,
    anchorId: 'w03',
    quote:
      "it only ever increments, so after three wakes in a session's life the fourth wake is refused",
    status: 'sent',
    reason: { actor: 'The agent', verb: 'replied to your comment' },
    needsYou: true,
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
        body: 'Yes, most likely. That chat had three earlier wakes.\n\nFixed in `a3f9c21`:\n- reset on normal wake\n- reset on restore from snapshot\n- new test: four wakes in a row all succeed',
      },
    ],
  },
  {
    id: 't-mine',
    sessionId: WEBHOOK_CHAT.id,
    anchorId: 'm05',
    quote: 'Add a test that replays the same event three times.',
    status: 'sent',
    reason: { actor: 'You', verb: 'sent this to the agent' },
    needsYou: false,
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
];

/** Position of an item in its session, 1-based, for "Message 5 of 17". */
export function positionOf(session: ChatSession, itemId: string): number {
  return session.items.findIndex((item) => item.id === itemId) + 1;
}
