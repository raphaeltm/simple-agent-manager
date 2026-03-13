/**
 * Session ID mismatch fix — source contract tests.
 *
 * Verifies that the chat session detail route looks up the active agent session
 * ID from D1 and includes it in the response, so the UI can route ACP WebSocket
 * connections to the correct VM agent session instead of creating duplicates.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const chatRouteSource = readFileSync(
  resolve(process.cwd(), 'src/routes/chat.ts'),
  'utf8'
);

describe('Chat session detail includes agentSessionId', () => {
  it('queries agent_sessions table by workspaceId and running status', () => {
    expect(chatRouteSource).toContain('schema.agentSessions.workspaceId');
    expect(chatRouteSource).toContain('schema.agentSessions.status');
    expect(chatRouteSource).toContain("'running'");
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
