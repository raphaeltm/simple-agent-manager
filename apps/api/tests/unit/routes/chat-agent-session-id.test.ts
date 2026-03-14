/**
 * Session ID stability fix — source contract tests.
 *
 * Verifies that the chat session detail route looks up the most recent agent
 * session ID from D1 (regardless of status) and includes it in the response,
 * so the UI can route ACP WebSocket connections to the correct VM agent
 * session instead of creating duplicates.
 *
 * The query MUST NOT filter by status='running' — suspended or other
 * transient statuses should still return the agent session ID so the browser
 * reconnects to the same SessionHost and preserves conversation context.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const chatRouteSource = readFileSync(
  resolve(process.cwd(), 'src/routes/chat.ts'),
  'utf8'
);

describe('Chat session detail includes agentSessionId', () => {
  it('queries agent_sessions table by workspaceId without status filter', () => {
    // Must query by workspaceId
    expect(chatRouteSource).toContain('schema.agentSessions.workspaceId');

    // Extract the agentSessionId lookup block
    const lookupStart = chatRouteSource.indexOf('let agentSessionId');
    const lookupEnd = chatRouteSource.indexOf('return c.json({', lookupStart);
    const lookupBlock = chatRouteSource.slice(lookupStart, lookupEnd);

    // Must NOT filter by status='running' — this was the root cause of the
    // conversation-clearing bug. When the agent session was suspended, the
    // query returned null, causing the UI to switch to the chat session ID
    // and create a new SessionHost on the VM agent.
    expect(lookupBlock).not.toContain("'running'");

    // Must order by creation date descending to get the most recent session
    expect(chatRouteSource).toContain('desc(schema.agentSessions.createdAt)');
  });

  it('includes agentSessionId in the response JSON', () => {
    expect(chatRouteSource).toContain('agentSessionId');
    expect(chatRouteSource).toContain('session: { ...session, agentSessionId, task }');
  });

  it('handles D1 lookup failure gracefully (non-fatal)', () => {
    // Extract the agentSessionId lookup block
    const lookupStart = chatRouteSource.indexOf('let agentSessionId');
    const lookupEnd = chatRouteSource.indexOf('return c.json({', lookupStart);
    const lookupBlock = chatRouteSource.slice(lookupStart, lookupEnd);

    expect(lookupBlock).toContain('try {');
    expect(lookupBlock).toContain('catch');
    expect(lookupBlock).toContain('non-fatal');
  });

  it('only queries when workspace is linked (workspaceId not null)', () => {
    const lookupStart = chatRouteSource.indexOf('let agentSessionId');
    const lookupEnd = chatRouteSource.indexOf('return c.json({', lookupStart);
    const lookupBlock = chatRouteSource.slice(lookupStart, lookupEnd);

    expect(lookupBlock).toContain('if (workspaceId)');
  });
});
