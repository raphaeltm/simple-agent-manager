// Mock data for Chat Session Timeline prototype
// Stress-tests: 15+ human turns, very long messages, all 6 notification types,
// empty state, single-message session, special characters/emoji

export type NotificationType =
  | 'task_complete'
  | 'needs_input'
  | 'error'
  | 'progress'
  | 'pr_created'
  | 'session_ended';

export interface MockMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** If true, this message is "not loaded" (lazy history) */
  isUnloaded?: boolean;
}

export interface MockNotification {
  id: string;
  type: NotificationType;
  title: string;
  createdAt: number;
  actionUrl?: string;
}

export type TimelineEntry =
  | { kind: 'message'; data: MockMessage }
  | { kind: 'notification'; data: MockNotification }
  | { kind: 'lazy-boundary' };

// --- Helpers ---

let _ts = Date.now() - 3 * 60 * 60 * 1000; // start 3h ago
function ts(minutesLater: number): number {
  _ts += minutesLater * 60 * 1000;
  return _ts;
}

function msg(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  minutesLater: number,
  isUnloaded?: boolean,
): MockMessage {
  return { id, role, content, createdAt: ts(minutesLater), isUnloaded };
}

function notif(
  id: string,
  type: NotificationType,
  title: string,
  minutesLater: number,
  actionUrl?: string,
): MockNotification {
  return { id, type, title, createdAt: ts(minutesLater), actionUrl };
}

// --- Long session (15+ human turns) ---

const LONG_TEXT =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Vivamus lacinia odio vitae vestibulum vestibulum.';

const EMOJI_TEXT =
  'Hey! Can you check the build? It keeps failing with a weird error. The stacktrace mentions something about circular deps in the shared package.';

const SPECIAL_CHARS_TEXT =
  'Fix the <script>alert("xss")</script> vulnerability in the login form. Also handle &amp; entities and "quoted strings" properly. Path: src/components/Auth.tsx:42';

export const LONG_SESSION_MESSAGES: MockMessage[] = [
  // Unloaded messages (lazy history)
  msg('m-old-1', 'user', 'Started setting up the project yesterday...', 0, true),
  msg('m-old-2', 'assistant', 'I created the initial scaffold with the recommended structure.', 1, true),
  msg('m-old-3', 'user', 'Looks good, let me check the tests', 2, true),

  // Loaded messages
  msg('m-1', 'user', EMOJI_TEXT, 5),
  msg(
    'm-1a',
    'assistant',
    'I see the issue. The `@simple-agent-manager/shared` package has a circular dependency between `types/session.ts` and `types/task.ts`. Let me trace the import chain and fix it.',
    1,
  ),
  msg('m-2', 'user', 'Can you also add the notification types while you are at it?', 3),
  msg(
    'm-2a',
    'assistant',
    'Sure! I\'ll add the notification type definitions to `packages/shared/src/types/notification.ts` with all six types: `task_complete`, `needs_input`, `error`, `progress`, `pr_created`, and `session_ended`.',
    1,
  ),
  msg('m-3', 'user', LONG_TEXT, 4),
  msg(
    'm-3a',
    'assistant',
    'That\'s a great point about the architecture. I\'ll restructure the provider abstraction to support multiple cloud backends without breaking the existing Hetzner integration. The key change is moving the credential encryption into the provider layer itself.',
    2,
  ),
  msg('m-4', 'user', SPECIAL_CHARS_TEXT, 5),
  msg(
    'm-4a',
    'assistant',
    'I\'ve sanitized the input handling and added proper HTML entity escaping. The fix is in `src/components/Auth.tsx` — I\'ve also added a regression test.',
    1,
  ),
  msg('m-5', 'user', 'Run the full test suite and check for regressions', 2),
  msg(
    'm-5a',
    'assistant',
    'All 847 tests pass. No regressions detected. The circular dependency fix resolved 3 previously flaky tests in the shared package.',
    3,
  ),
  msg('m-6', 'user', 'Great. Now let me think about the deployment strategy...', 4),
  msg(
    'm-6a',
    'assistant',
    'While you think about that, I can share that the current deployment pipeline uses Pulumi for infrastructure and Wrangler for the Cloudflare Workers. Staging deploys take about 7 minutes.',
    1,
  ),
  msg('m-7', 'user', 'Deploy to staging and verify everything works', 6),
  msg('m-7a', 'assistant', 'Triggering staging deployment now via `gh workflow run deploy-staging.yml`.', 0.5),
  msg('m-8', 'user', 'How long will that take?', 1),
  msg('m-8a', 'assistant', 'The staging deployment typically takes 6-8 minutes. I\'ll monitor the workflow.', 0.5),
  msg('m-9', 'user', 'Check the database schema while we wait', 3),
  msg(
    'm-9a',
    'assistant',
    'The D1 schema has 23 tables. Key tables: `users`, `projects`, `nodes`, `workspaces`, `tasks`. All migrations are up to date (latest: 0063_skills.sql).',
    1,
  ),
  msg('m-10', 'user', 'What about the warm node pool? Any issues?', 2),
  msg(
    'm-10a',
    'assistant',
    'The warm node pool is functioning correctly. Three-layer defense against orphans: DO alarm + cron sweep + max lifetime. Current warm timeout is 30 minutes (configurable via `NODE_WARM_TIMEOUT_MS`).',
    1,
  ),
  msg(
    'm-11',
    'user',
    'Perfect. Can you write a summary of everything we did in this session? Include all the changes, what was fixed, and what was deployed. Make it detailed enough that someone picking up the work tomorrow would know exactly where we left off.',
    5,
  ),
  msg(
    'm-11a',
    'assistant',
    'Here\'s a comprehensive summary of this session:\n\n1. **Circular dependency fix** — Resolved the import cycle between `types/session.ts` and `types/task.ts` in the shared package.\n2. **Notification types** — Added all 6 notification type definitions.\n3. **XSS fix** — Sanitized input handling in `Auth.tsx` with proper HTML entity escaping.\n4. **Test suite** — All 847 tests passing, 3 previously flaky tests now stable.\n5. **Staging deployment** — Triggered and monitoring.\n6. **Schema review** — 23 tables, migrations current.\n7. **Warm pool verification** — Three-layer orphan defense working correctly.',
    2,
  ),
  msg('m-12', 'user', 'Ship it!', 1),
  msg('m-12a', 'assistant', 'Creating PR and merging to main. Production deployment will trigger automatically.', 0.5),
  msg('m-13', 'user', 'One more thing: can you check if there are any open issues related to the provider abstraction?', 3),
  msg(
    'm-13a',
    'assistant',
    'Found 2 open issues:\n- #142: Scaleway provider support (backlog)\n- #187: Provider credential rotation (active)\n\nNeither is blocking the current deployment.',
    1,
  ),
  msg('m-14', 'user', 'Thanks, we can pick those up tomorrow', 1),
  msg(
    'm-14a',
    'assistant',
    'Sounds good! The PR has been merged and the production deployment is in progress. I\'ll keep monitoring until it completes.',
    0.5,
  ),
  msg('m-15', 'user', 'Any final status update?', 8),
  msg(
    'm-15a',
    'assistant',
    'Production deployment completed successfully. All features are live and verified. The circular dependency fix, notification types, and XSS patch are all deployed.',
    1,
  ),
];

export const LONG_SESSION_NOTIFICATIONS: MockNotification[] = [
  notif('n-1', 'progress', 'Staging deployment started', 0.5),
  notif('n-2', 'progress', 'Build step completed (2/5)', 2),
  notif('n-3', 'task_complete', 'Staging deployment succeeded', 5),
  notif('n-4', 'needs_input', 'Review required: 3 new permissions requested', 3, '/projects/proj-1/settings'),
  notif('n-5', 'pr_created', 'PR #291: Fix circular deps & add notifications', 2, 'https://github.com/org/repo/pull/291'),
  notif('n-6', 'error', 'Flaky test detected: workspace.integration.test.ts', 1),
  notif('n-7', 'task_complete', 'Production deployment completed', 8),
  notif('n-8', 'session_ended', 'Agent session ended normally', 1),
];

// Build the interleaved timeline
function buildTimeline(messages: MockMessage[], notifications: MockNotification[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  // Add lazy boundary before the loaded messages
  const unloaded = messages.filter((m) => m.isUnloaded);
  const loaded = messages.filter((m) => !m.isUnloaded);

  for (const m of unloaded) {
    entries.push({ kind: 'message', data: m });
  }
  if (unloaded.length > 0) {
    entries.push({ kind: 'lazy-boundary' });
  }

  // Interleave loaded messages and notifications by timestamp
  const msgEntries: TimelineEntry[] = loaded.map((m) => ({ kind: 'message', data: m }));
  const notifEntries: TimelineEntry[] = notifications.map((n) => ({ kind: 'notification', data: n }));
  const combined = [...msgEntries, ...notifEntries].sort((a, b) => {
    const tA = a.kind === 'message' ? a.data.createdAt : a.kind === 'notification' ? a.data.createdAt : 0;
    const tB = b.kind === 'message' ? b.data.createdAt : b.kind === 'notification' ? b.data.createdAt : 0;
    return tA - tB;
  });

  entries.push(...combined);
  return entries;
}

export const LONG_SESSION_TIMELINE = buildTimeline(LONG_SESSION_MESSAGES, LONG_SESSION_NOTIFICATIONS);

// --- V2 density toggle: mocked agent snippets before each human message ---

export interface AgentSnippet {
  /** The user message ID this snippet precedes */
  beforeMessageId: string;
  content: string;
}

export const AGENT_SNIPPETS: AgentSnippet[] = LONG_SESSION_MESSAGES.filter((m) => m.role === 'assistant' && !m.isUnloaded).map(
  (m) => ({
    beforeMessageId: m.id,
    content: m.content.length > 120 ? m.content.slice(0, 117) + '...' : m.content,
  }),
);

// --- Empty state ---
export const EMPTY_TIMELINE: TimelineEntry[] = [];

// --- Single message session ---
_ts = Date.now() - 10 * 60 * 1000; // reset
export const SINGLE_MESSAGE_TIMELINE: TimelineEntry[] = [
  { kind: 'message', data: msg('sm-1', 'user', 'Hello, is anyone there?', 0) },
];

// --- Notification color/icon mapping ---

export const NOTIFICATION_STYLES: Record<
  NotificationType,
  { color: string; bgColor: string; icon: string }
> = {
  task_complete: { color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.15)', icon: 'check-circle' },
  needs_input: { color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.15)', icon: 'alert-circle' },
  error: { color: '#ef4444', bgColor: 'rgba(239, 68, 68, 0.15)', icon: 'x-circle' },
  progress: { color: '#9fb7ae', bgColor: 'rgba(159, 183, 174, 0.1)', icon: 'loader' },
  pr_created: { color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.15)', icon: 'git-pull-request' },
  session_ended: { color: '#9fb7ae', bgColor: 'rgba(159, 183, 174, 0.1)', icon: 'log-out' },
};
