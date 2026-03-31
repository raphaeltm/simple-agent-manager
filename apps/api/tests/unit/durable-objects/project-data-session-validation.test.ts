/**
 * Source contract tests for ProjectData DO session validation.
 *
 * Verifies that:
 * 1. WebSocket message.send validates sessionId against the WebSocket's session tag
 * 2. WebSocket message.send validates session exists and is active before persisting
 * 3. persistMessageBatch rejects messages to stopped sessions
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ProjectData DO session validation contracts', () => {
  const file = [
    readFileSync(resolve(process.cwd(), 'src/durable-objects/project-data/index.ts'), 'utf8'),
    readFileSync(resolve(process.cwd(), 'src/durable-objects/project-data/messages.ts'), 'utf8'),
  ].join('\n');

  describe('WebSocket message.send session tag validation', () => {
    it('retrieves WebSocket tags for session matching', () => {
      expect(file).toContain('this.ctx.getTags(ws)');
    });

    it('checks for session tag prefix', () => {
      expect(file).toContain("t.startsWith('session:')");
    });

    it('extracts session ID from tag and compares to message sessionId', () => {
      expect(file).toContain("wsSessionTag.slice('session:'.length)");
      expect(file).toContain('wsSessionId !== sessionId');
    });

    it('rejects messages with session mismatch error', () => {
      expect(file).toContain('Session mismatch: WebSocket connected to session');
    });

    it('logs session mismatch with diagnostic context', () => {
      expect(file).toContain('websocket_session_mismatch');
      expect(file).toContain('wsSessionId');
      expect(file).toContain('messageSessionId');
    });
  });

  describe('WebSocket message.send session status validation', () => {
    it('queries session existence and status before persisting', () => {
      expect(file).toContain(
        "SELECT id, status FROM chat_sessions WHERE id = ?"
      );
    });

    it('rejects messages to non-existent sessions', () => {
      expect(file).toContain('not found');
    });

    it('rejects messages to non-active sessions', () => {
      expect(file).toContain("targetSession.status !== 'active'");
    });
  });

  describe('persistMessageBatch stopped session rejection', () => {
    it('checks session status in persistMessageBatch', () => {
      expect(file).toContain("session.status === 'stopped'");
    });

    it('throws descriptive error for stopped sessions', () => {
      expect(file).toContain('is stopped and cannot accept messages');
    });
  });
});
