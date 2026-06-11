/**
 * Mock data for the Chat Timeline prototype.
 * Stress-tests the UI with long text, all notification types, empty states, etc.
 */

export interface MockMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: number;
  /** If true, this message is in the "lazy history" zone — not yet loaded */
  lazy?: boolean;
}

export interface MockNotification {
  id: string;
  type: 'task_complete' | 'needs_input' | 'error' | 'progress' | 'pr_created' | 'session_ended';
  title: string;
  timestamp: number;
  actionUrl?: string;
}

export type TimelineEntry =
  | { kind: 'user_message'; message: MockMessage; agentSnippet?: string }
  | { kind: 'notification'; notification: MockNotification };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TS = Date.now() - 3_600_000; // 1 hour ago

function ts(minutesAgo: number): number {
  return BASE_TS + (60 - minutesAgo) * 60_000;
}

// ---------------------------------------------------------------------------
// Long session dataset (15+ human turns)
// ---------------------------------------------------------------------------

export const LONG_SESSION_MESSAGES: MockMessage[] = [
  // Lazy history zone (first few messages)
  { id: 'msg-01', role: 'user', text: 'Hey, can you set up the project with TypeScript and ESLint?', timestamp: ts(58), lazy: true },
  { id: 'msg-02', role: 'assistant', text: 'Sure! I\'ll initialize the project with TypeScript 5.x, ESLint with the recommended config, and Prettier for formatting. Let me set that up now.', timestamp: ts(57), lazy: true },
  { id: 'msg-03', role: 'user', text: 'Also add Vitest for testing', timestamp: ts(56), lazy: true },
  { id: 'msg-04', role: 'assistant', text: 'Done! Added Vitest with the UI reporter and coverage via V8. The test command is `pnpm test`.', timestamp: ts(55), lazy: true },

  // Loaded messages start here
  { id: 'msg-05', role: 'user', text: 'Now let\'s build the authentication system. We need GitHub OAuth with PKCE flow, session management via encrypted cookies, and a middleware that validates the session on every request. The session should include the user ID, GitHub username, avatar URL, and the OAuth access token (encrypted at rest). Make sure to handle token refresh gracefully.', timestamp: ts(50) },
  { id: 'msg-06', role: 'assistant', text: 'I\'ll implement the full auth flow:\n\n1. **GitHub OAuth with PKCE** - Using `@hono/oauth-providers` for the OAuth dance with code_verifier/code_challenge\n2. **Session cookies** - AES-256-GCM encrypted, HttpOnly, SameSite=Lax, 7-day expiry\n3. **Middleware** - `requireAuth()` validates + decrypts the session cookie on every request\n4. **Token refresh** - Background refresh when the access token is within 5 minutes of expiry\n\nLet me start with the OAuth callback handler...', timestamp: ts(49) },
  { id: 'msg-07', role: 'user', text: 'Looks good. Can you add rate limiting too? I want 100 requests per minute per user, with a 429 response and Retry-After header when exceeded.', timestamp: ts(45) },
  { id: 'msg-08', role: 'assistant', text: 'Added rate limiting using a sliding window counter in KV. Each user gets a key `rate:{userId}` with a 60-second TTL. The middleware checks the count before processing and returns `429 Too Many Requests` with a `Retry-After` header showing seconds until the window resets.\n\n```typescript\nif (count > RATE_LIMIT) {\n  return c.json({ error: \'Rate limit exceeded\' }, 429, {\n    \'Retry-After\': String(Math.ceil(windowReset / 1000)),\n  });\n}\n```', timestamp: ts(44) },
  { id: 'msg-09', role: 'user', text: 'The tests are failing for the auth middleware. Can you check?', timestamp: ts(40) },
  { id: 'msg-10', role: 'assistant', text: 'Found the issue! The test was mocking the cookie parser incorrectly. The encrypted session payload includes a 12-byte IV prepended to the ciphertext, but the mock was only providing the ciphertext without the IV. Fixed the test helper to generate properly structured mock sessions.\n\nAll 47 tests passing now.', timestamp: ts(39) },
  { id: 'msg-11', role: 'user', text: 'Great. Now let\'s add the workspace CRUD API. I need endpoints for creating, listing, getting, starting, stopping, and deleting workspaces. Each workspace belongs to a project and has a status enum: pending, creating, running, stopping, stopped, error. Include proper validation and ownership checks.', timestamp: ts(35) },
  { id: 'msg-12', role: 'assistant', text: 'Implementing the workspace API with full lifecycle management. Here\'s the route structure:\n\n- `POST /api/projects/:projectId/workspaces` - Create\n- `GET /api/projects/:projectId/workspaces` - List (filtered by project)\n- `GET /api/workspaces/:id` - Get details\n- `POST /api/workspaces/:id/start` - Start\n- `POST /api/workspaces/:id/stop` - Stop\n- `DELETE /api/workspaces/:id` - Delete\n\nEvery endpoint validates `userId` ownership via the auth middleware, and state transitions are enforced (can\'t start a workspace that\'s already running, etc.).', timestamp: ts(34) },
  { id: 'msg-13', role: 'user', text: 'Add WebSocket support for real-time workspace logs', timestamp: ts(30) },
  { id: 'msg-14', role: 'assistant', text: 'Added WebSocket endpoint at `/api/workspaces/:id/logs`. The connection authenticates using the session cookie (or a `?token=` query param for CLI clients). Log messages are streamed as JSON frames with `{ type: "log", timestamp, level, message }` format. The connection auto-closes when the workspace stops.', timestamp: ts(29) },
  { id: 'msg-15', role: 'user', text: 'We need to handle the edge case where a user has special characters in their GitHub username, like `o\'brien-dev` or usernames with unicode. The display name should be sanitized for HTML but preserved for API responses. Can you also add emoji support in workspace names? Some users like naming their workspaces with emoji like "rocket-deploy" or "bug-hunt".', timestamp: ts(25) },
  { id: 'msg-16', role: 'assistant', text: 'Good catch on the special characters! Here\'s what I did:\n\n1. **GitHub usernames** - Stored as-is in the DB, HTML-escaped only at render time using the existing `escapeHtml()` utility. API responses return the raw username.\n2. **Workspace names** - Added a validation regex that allows Unicode letters, numbers, emoji, hyphens, and underscores: `/^[\\p{L}\\p{N}\\p{Emoji_Presentation}\\-_\\s]{1,64}$/u`\n3. **Display sanitization** - The `stripMarkdown()` utility already handles most cases; I added explicit handling for `<script>` tag stripping.\n\nTest cases added for: `o\'brien-dev`, `user`, `rocket-deploy`, `bug-hunt-v2`', timestamp: ts(24) },
  { id: 'msg-17', role: 'user', text: 'Deploy to staging and verify', timestamp: ts(20) },
  { id: 'msg-18', role: 'assistant', text: 'Deploying to staging now. The build completed successfully and the deployment workflow is running.\n\nI\'ll verify all endpoints once the deploy lands (~7 minutes).', timestamp: ts(19) },
  { id: 'msg-19', role: 'user', text: 'The staging deploy failed. Can you check the logs?', timestamp: ts(15) },
  { id: 'msg-20', role: 'assistant', text: 'Checked the deployment logs. The failure was in the D1 migration step:\n\n```\nError: Migration 0023_workspace_status.sql failed: UNIQUE constraint failed: workspaces.name\n```\n\nThe staging database already had a workspace named "test-workspace" from a previous migration. The new migration tried to insert a seed row with the same name. Fixed by using `INSERT OR IGNORE` for seed data.\n\nRe-deploying now.', timestamp: ts(14) },
  { id: 'msg-21', role: 'user', text: 'OK the deploy succeeded. Can you run the full regression test suite against staging?', timestamp: ts(10) },
  { id: 'msg-22', role: 'assistant', text: 'Running the full regression suite against staging. 142 tests in 4 suites:\n\n- Auth flow: 23/23 passed\n- Workspace CRUD: 38/38 passed\n- Rate limiting: 12/12 passed\n- WebSocket logs: 8/8 passed\n- Integration (end-to-end): 61/61 passed\n\nAll green! The staging environment is healthy and all features are working end-to-end.', timestamp: ts(9) },
  { id: 'msg-23', role: 'user', text: 'Perfect. Let\'s create the PR and merge.', timestamp: ts(5) },
  { id: 'msg-24', role: 'assistant', text: 'PR created: **#847 — feat: workspace CRUD API with auth, rate limiting, and WebSocket logs**\n\nCI is running now. I\'ll monitor the deploy after merge.', timestamp: ts(4) },
  { id: 'msg-25', role: 'user', text: 'Merged. How does the production deploy look?', timestamp: ts(2) },
  { id: 'msg-26', role: 'assistant', text: 'Production deploy completed successfully! All health checks passing:\n\n- API: `https://api.simple-agent-manager.org/health` -> 200 OK\n- Auth flow: GitHub OAuth redirect works\n- Workspace creation: Verified with a test workspace, then cleaned up\n\nThe feature is live.', timestamp: ts(1) },
];

export const LONG_SESSION_NOTIFICATIONS: MockNotification[] = [
  { id: 'notif-01', type: 'progress', title: 'Building auth module...', timestamp: ts(48) },
  { id: 'notif-02', type: 'task_complete', title: 'Auth middleware implemented', timestamp: ts(43) },
  { id: 'notif-03', type: 'error', title: 'Test suite failed: 3 failures in auth.test.ts', timestamp: ts(41) },
  { id: 'notif-04', type: 'task_complete', title: 'All tests passing (47/47)', timestamp: ts(38) },
  { id: 'notif-05', type: 'progress', title: 'Implementing workspace CRUD endpoints...', timestamp: ts(33) },
  { id: 'notif-06', type: 'needs_input', title: 'Should workspace names allow spaces?', timestamp: ts(26) },
  { id: 'notif-07', type: 'error', title: 'Staging deploy failed: D1 migration error', timestamp: ts(16) },
  { id: 'notif-08', type: 'task_complete', title: 'Staging deploy succeeded', timestamp: ts(12) },
  { id: 'notif-09', type: 'pr_created', title: 'PR #847 created', timestamp: ts(4), actionUrl: 'https://github.com/org/repo/pull/847' },
  { id: 'notif-10', type: 'session_ended', title: 'Session completed successfully', timestamp: ts(0) },
];

// ---------------------------------------------------------------------------
// Single message dataset
// ---------------------------------------------------------------------------

export const SINGLE_MESSAGE_MESSAGES: MockMessage[] = [
  { id: 'single-01', role: 'user', text: 'What\'s in this repo?', timestamp: ts(2) },
  { id: 'single-02', role: 'assistant', text: 'This is a monorepo containing a serverless platform for AI coding agents. The main packages are...', timestamp: ts(1) },
];

export const SINGLE_MESSAGE_NOTIFICATIONS: MockNotification[] = [];

// ---------------------------------------------------------------------------
// Empty dataset
// ---------------------------------------------------------------------------

export const EMPTY_MESSAGES: MockMessage[] = [];
export const EMPTY_NOTIFICATIONS: MockNotification[] = [];

// ---------------------------------------------------------------------------
// Build timeline entries from messages + notifications
// ---------------------------------------------------------------------------

export function buildTimeline(
  messages: MockMessage[],
  notifications: MockNotification[],
  showAgentSnippets: boolean,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  // Only user messages go in the timeline
  const userMessages = messages.filter((m) => m.role === 'user');

  // For V2 density, find the assistant message immediately before each user message
  const agentSnippets = new globalThis.Map<string, string>();
  if (showAgentSnippets) {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role === 'user' && i > 0) {
        const prev = messages[i - 1]!;
        if (prev.role === 'assistant') {
          agentSnippets.set(messages[i]!.id, prev.text);
        }
      }
    }
  }

  // Merge user messages and notifications chronologically
  const allItems: Array<{ timestamp: number; entry: TimelineEntry }> = [];

  for (const msg of userMessages) {
    allItems.push({
      timestamp: msg.timestamp,
      entry: {
        kind: 'user_message',
        message: msg,
        agentSnippet: agentSnippets.get(msg.id),
      },
    });
  }

  for (const notif of notifications) {
    allItems.push({
      timestamp: notif.timestamp,
      entry: { kind: 'notification', notification: notif },
    });
  }

  allItems.sort((a, b) => a.timestamp - b.timestamp);
  for (const item of allItems) {
    entries.push(item.entry);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Mock session list (for the sidebar)
// ---------------------------------------------------------------------------

export interface MockSession {
  id: string;
  topic: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  mode: 'task' | 'chat';
  updatedAt: number;
}

export const MOCK_SESSIONS: MockSession[] = [
  { id: 'sess-active', topic: 'Workspace CRUD API with auth and WebSocket logs', status: 'running', mode: 'task', updatedAt: ts(0) },
  { id: 'sess-done-1', topic: 'Fix TLS certificate rotation', status: 'completed', mode: 'task', updatedAt: ts(60) },
  { id: 'sess-done-2', topic: 'Debug staging deploy failure', status: 'completed', mode: 'chat', updatedAt: ts(120) },
  { id: 'sess-failed', topic: 'Add Scaleway provider support', status: 'failed', mode: 'task', updatedAt: ts(180) },
  { id: 'sess-stopped', topic: 'Refactor node lifecycle DO', status: 'stopped', mode: 'task', updatedAt: ts(240) },
];

// ---------------------------------------------------------------------------
// Notification colors and icons (for the timeline UI)
// ---------------------------------------------------------------------------

export const NOTIFICATION_STYLES: Record<MockNotification['type'], { color: string; bgColor: string; label: string }> = {
  task_complete: { color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.12)', label: 'Complete' },
  needs_input: { color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.12)', label: 'Needs Input' },
  error: { color: '#ef4444', bgColor: 'rgba(239, 68, 68, 0.12)', label: 'Error' },
  progress: { color: '#9fb7ae', bgColor: 'rgba(159, 183, 174, 0.08)', label: 'Progress' },
  pr_created: { color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.12)', label: 'PR Created' },
  session_ended: { color: '#9fb7ae', bgColor: 'rgba(159, 183, 174, 0.08)', label: 'Ended' },
};
