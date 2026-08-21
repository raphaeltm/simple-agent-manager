/**
 * Stress-test mock data for the commenting prototype.
 *
 * Per `.claude/rules/37-prototype-development.md`, this deliberately pushes UI
 * boundaries: 200+ char names, 500+ char bodies, unbroken URLs, emoji/CJK/RTL,
 * single-character bodies, deep reply chains, and all three status states.
 */

import type { Comment, CommentAuthor, PrototypeMessage } from './comment-types';

/** Fixed clock so screenshots are deterministic across runs. */
export const NOW = new Date('2026-08-21T14:30:00Z').getTime();

const MIN = 60_000;

export const RAPHAEL: CommentAuthor = {
  id: 'u-raph',
  name: 'Raphaël Titsworth-Morin',
  kind: 'human',
  initials: 'RT',
};

export const TEAMMATE: CommentAuthor = {
  id: 'u-jo',
  name: 'Jo',
  kind: 'human',
  initials: 'JO',
};

export const LONG_NAME_USER: CommentAuthor = {
  id: 'u-long',
  name: 'Bartholomew Fitzgerald-Montgomery III, Senior Principal Distinguished Staff Engineer (Platform Reliability & Observability Working Group)',
  kind: 'human',
  initials: 'BF',
};

export const AGENT: CommentAuthor = {
  id: 'a-claude',
  name: 'Claude Opus 5',
  kind: 'agent',
  initials: 'AI',
};

// ---------------------------------------------------------------------------
// Chat transcript
// ---------------------------------------------------------------------------

const LONG_AGENT_MESSAGE = `I've traced the failure through all three layers. Here's what's happening:

The \`session_snapshots.recovery_attempts\` column is a **lifetime** counter, not a consecutive-failure budget. \`claimSessionSnapshotRecovery\` increments it on *every* claim — including the ones that succeed — and it's only ever set to \`0\` at row creation.

Both success paths reset \`sleepAttempts\` but omit \`recoveryAttempts\`:

\`\`\`ts
// session-snapshot-recovery-lifecycle.ts:322
await db.update(sessionSnapshots).set({
  sleepStatus: 'awake',
  sleepAttempts: 0,        // <-- reset
  // recoveryAttempts: 0,  <-- MISSING
}).where(eq(sessionSnapshots.id, snapshotId));
\`\`\`

The snapshot row is per-chat-session and reused across cycles, so after 3 *successful* sleep/wake cycles the session becomes permanently unwakeable. \`task-runtime-liveness.ts\` mirrors the same predicate, so the task then gets terminally failed as "conclusively gone".

The fix is one line in each of the two success paths. I'd also add a multi-cycle regression test that runs N+1 cycles and asserts the last one still succeeds — that's the test that would have caught this.`;

const SPECIAL_CHARS_MESSAGE = `Handled the encoding edge cases 🎉 — here's the summary:

- Emoji: 👨‍👩‍👧‍👦 🇫🇷 🧑🏽‍💻 (ZWJ sequences + skin tone modifiers)
- CJK: 日本語のテキストも正しく折り返されます
- RTL: مرحبا بالعالم — mixed with English
- HTML entities: &lt;script&gt;alert('xss')&lt;/script&gt; &amp; &copy;
- Unbroken URL: https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/d1/database/1cfaf5d4-8226-47d8-bf26-6ba727ce5718/query
- Long token: supercalifragilisticexpialidocious_but_much_longer_and_entirely_unbreakable_identifier_0123456789`;

export const MESSAGES: PrototypeMessage[] = [
  {
    id: 'm-1',
    role: 'user',
    text: 'Can you look into why sessions become permanently unwakeable after a few sleep cycles?',
    timestamp: NOW - 48 * MIN,
  },
  {
    id: 'm-2',
    role: 'agent',
    text: LONG_AGENT_MESSAGE,
    timestamp: NOW - 44 * MIN,
  },
  {
    id: 'm-3',
    role: 'user',
    text: 'k',
    timestamp: NOW - 30 * MIN,
  },
  {
    id: 'm-4',
    role: 'agent',
    text: 'Pushed the fix to `sam/fix-recovery-attempts-reset`. Both success paths now reset the counter, and the regression test runs 4 cycles against a 3-attempt budget.',
    timestamp: NOW - 26 * MIN,
  },
  {
    id: 'm-5',
    role: 'agent',
    text: SPECIAL_CHARS_MESSAGE,
    timestamp: NOW - 12 * MIN,
  },
  {
    id: 'm-6',
    role: 'agent',
    text: 'Anything else you want me to pick up here?',
    timestamp: NOW - 4 * MIN,
  },
];

// ---------------------------------------------------------------------------
// Markdown document
// ---------------------------------------------------------------------------

export const MARKDOWN_PATH = 'docs/architecture/session-lifecycle.md';

export const MARKDOWN_DOC = `# Session Lifecycle

A session moves through four states. Every cleanup timer in the platform must agree
on what "idle" means, or work gets terminalized while it is still recoverable.

## States

| State | Compute held | Wakeable | Notes |
| --- | --- | --- | --- |
| \`active\` | yes | n/a | An agent turn is in flight |
| \`idle\` | yes | n/a | Control returned to the user |
| \`sleeping\` | no | yes | Snapshot captured, workspace released |
| \`archived\` | no | no | Terminal, irreversible |

## Definition of idle

A session is idle **only** when the agent has handed control back to the user *and*
nothing the agent started is still running. Specifically, all of the following:

1. The ACP prompt turn has ended.
2. No tool call the agent made is still executing.
3. No sub-agent or subtask the agent created is still running.

"The user is not typing" is not idleness. "The runtime is alive" is not non-idleness.
Both existing predicates encode one of those wrong proxies.

## Recovery budget

Recovery attempts are bounded so a permanently broken snapshot cannot be retried
forever. The counter must reset on success — see https://github.com/raphaeltm/simple-agent-manager/blob/main/apps/api/src/services/session-snapshot-recovery-lifecycle.ts

\`\`\`ts
const MAX_RECOVERY_ATTEMPTS = 3;
\`\`\`

> A budget counter that accumulates across success boundaries silently becomes a
> lifetime cap. This is invisible for low-frequency users and only manifests after
> N successful cycles — exactly when the system should be most confident.

## Open questions

- Should archived sessions retain their transcript indefinitely?
- What is the correct absolute ceiling for a detached background process?
`;

// ---------------------------------------------------------------------------
// Comments — covers every status, empty threads, deep threads, edge-case text
// ---------------------------------------------------------------------------

const VERY_LONG_BODY = `This is the part I keep getting stuck on, and I want to write it out fully so we do not lose the reasoning again like we did last time. The counter reset is obviously correct, but the thing that actually worries me is that we have two predicates encoding the same question in two different files, and they disagree with each other in their own doc comments. Fixing the reset makes this specific bug go away without addressing the fact that the next person to add a third cleanup path will reintroduce it, because there is no single shared helper that owns the answer to "is this session recoverable". Can we pull both predicates into one function, have both call sites use it, and add a test that fails if a third call site appears without going through it? I would rather spend the extra day now than debug this again in six weeks.`;

export const INITIAL_COMMENTS: Comment[] = [
  // Whole-message comment, sent to the agent (the SAM-specific state).
  {
    id: 'c-1',
    anchor: { kind: 'message', messageId: 'm-2' },
    author: RAPHAEL,
    body: 'Good catch. Please also add the multi-cycle regression test before you touch the reset — I want to see it go red first.',
    createdAt: NOW - 40 * MIN,
    status: 'sent',
    replies: [
      {
        id: 'r-1',
        author: AGENT,
        body: 'On it. Writing the 4-cycle test now and will confirm it fails against current main before applying the one-line fix.',
        createdAt: NOW - 39 * MIN,
      },
    ],
  },
  // Selection-anchored comment on a message — the quote is the point.
  {
    id: 'c-2',
    anchor: {
      kind: 'message',
      messageId: 'm-2',
      quote: 'The fix is one line in each of the two success paths.',
    },
    author: TEAMMATE,
    body: VERY_LONG_BODY,
    createdAt: NOW - 35 * MIN,
    status: 'open',
    replies: [
      {
        id: 'r-2',
        author: RAPHAEL,
        body: 'Agreed — one shared predicate. Let me open an idea for it.',
        createdAt: NOW - 33 * MIN,
      },
      {
        id: 'r-3',
        author: LONG_NAME_USER,
        body: '+1',
        createdAt: NOW - 32 * MIN,
      },
      {
        id: 'r-4',
        author: AGENT,
        body: 'I can do both in one branch — the shared helper plus the reset. Want me to?',
        createdAt: NOW - 31 * MIN,
      },
    ],
  },
  // Resolved comment — collapsed by default.
  {
    id: 'c-3',
    anchor: { kind: 'message', messageId: 'm-4' },
    author: RAPHAEL,
    body: 'Branch name is fine.',
    createdAt: NOW - 25 * MIN,
    status: 'resolved',
    replies: [],
  },
  // Single-character body + special-char anchor.
  {
    id: 'c-4',
    anchor: { kind: 'message', messageId: 'm-5', quote: '👨‍👩‍👧‍👦 🇫🇷 🧑🏽‍💻' },
    author: TEAMMATE,
    body: '?',
    createdAt: NOW - 10 * MIN,
    status: 'open',
    replies: [],
  },
  // --- Markdown file comments ---
  {
    id: 'c-5',
    anchor: {
      kind: 'file',
      path: MARKDOWN_PATH,
      // block-7 is the "The user is not typing…" paragraph. Block ids come from
      // `splitMarkdownBlocks(MARKDOWN_DOC)`; the audit pins these mappings.
      blockId: 'block-7',
      quote: '"The user is not typing" is not idleness.',
    },
    author: RAPHAEL,
    body: 'This is the sentence I want to keep. Every time someone rewrites this doc they soften it into "the user may still be active", which is exactly the wrong proxy.',
    createdAt: NOW - 20 * MIN,
    status: 'open',
    replies: [],
  },
  {
    id: 'c-6',
    // block-3 is the states table this comment is about (block-2 is its heading).
    anchor: { kind: 'file', path: MARKDOWN_PATH, blockId: 'block-3' },
    author: LONG_NAME_USER,
    body: 'The table is missing the `degraded` snapshot state — a session can be sleeping with a transcript-only snapshot, which is wakeable but lossy. Worth a fifth row.',
    createdAt: NOW - 18 * MIN,
    status: 'sent',
    replies: [
      {
        id: 'r-5',
        author: AGENT,
        body: 'Adding the row now, with a note that a degraded snapshot restores the transcript but not the working tree.',
        createdAt: NOW - 17 * MIN,
      },
    ],
  },
  {
    id: 'c-7',
    anchor: {
      kind: 'file',
      path: MARKDOWN_PATH,
      blockId: 'block-10',
      quote: 'const MAX_RECOVERY_ATTEMPTS = 3;',
    },
    author: TEAMMATE,
    body: 'Should this be env-configurable with a `DEFAULT_*` constant? Principle XI says no hardcoded limits.',
    createdAt: NOW - 8 * MIN,
    status: 'resolved',
    replies: [
      {
        id: 'r-6',
        author: RAPHAEL,
        body: 'Yes. Already tracked separately.',
        createdAt: NOW - 7 * MIN,
      },
    ],
  },
];

/** Empty-state variant — used by the audit to screenshot the zero-comment case. */
export const NO_COMMENTS: Comment[] = [];

/** Many-comments variant — 32 threads on one message, for scroll/density testing. */
export const MANY_COMMENTS: Comment[] = Array.from({ length: 32 }, (_, i) => ({
  id: `c-many-${i}`,
  anchor: { kind: 'message' as const, messageId: 'm-2' },
  author: i % 3 === 0 ? RAPHAEL : i % 3 === 1 ? TEAMMATE : LONG_NAME_USER,
  body:
    i % 5 === 0
      ? VERY_LONG_BODY
      : `Thread ${i + 1}: a routine review note about the recovery-attempt counter and its interaction with the sleep budget.`,
  createdAt: NOW - (40 - i) * MIN,
  status: (['open', 'sent', 'resolved'] as const)[i % 3] ?? 'open',
  replies:
    i % 4 === 0
      ? [
          {
            id: `r-many-${i}`,
            author: AGENT,
            body: 'Acknowledged.',
            createdAt: NOW - (39 - i) * MIN,
          },
        ]
      : [],
}));
