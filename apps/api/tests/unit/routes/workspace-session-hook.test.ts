/**
 * Source contract tests for workspace creation chat session hook.
 *
 * Verifies that workspace creation always creates a chat session (projectId
 * is now required), and that the runtime endpoint returns chatSessionId.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('workspace creation chat session hook source contract', () => {
  const routesFile = [
    readFileSync(resolve(process.cwd(), 'src/routes/workspaces/crud.ts'), 'utf8'),
    readFileSync(resolve(process.cwd(), 'src/routes/workspaces/runtime.ts'), 'utf8'),
  ].join('\n');
  const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');

  it('always creates chat session for workspace (projectId is required)', () => {
    expect(routesFile).toContain('projectDataService.createSession');
    expect(routesFile).toContain('chatSessionId');
    // projectId is now required — no conditional check
    expect(routesFile).toContain("throw errors.badRequest('projectId is required')");
  });

  it('stores chatSessionId on the workspace record', () => {
    expect(routesFile).toContain('set({ chatSessionId');
    expect(schemaFile).toContain("chatSessionId: text('chat_session_id')");
  });

  it('session creation failure does not block workspace creation (best-effort)', () => {
    expect(routesFile).toContain('Failed to create chat session for workspace');
    // The session creation is wrapped in a try/catch
    expect(routesFile).toContain('} catch (err) {');
  });

  it('runtime endpoint returns chatSessionId', () => {
    expect(routesFile).toContain('chatSessionId: schema.workspaces.chatSessionId');
    expect(routesFile).toContain('chatSessionId: workspace.chatSessionId');
  });
});
