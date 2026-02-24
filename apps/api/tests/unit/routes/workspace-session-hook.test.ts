/**
 * Source contract tests for workspace creation chat session hook.
 *
 * Verifies that workspace creation creates a chat session when linked
 * to a project, and that the runtime endpoint returns chatSessionId.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('workspace creation chat session hook source contract', () => {
  const routesFile = readFileSync(resolve(process.cwd(), 'src/routes/workspaces.ts'), 'utf8');
  const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');

  it('creates chat session when workspace is linked to a project', () => {
    expect(routesFile).toContain('projectDataService.createSession');
    expect(routesFile).toContain('if (linkedProject)');
    expect(routesFile).toContain('chatSessionId');
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

  it('workspace without project skips session creation', () => {
    // The condition checks for linkedProject (which is null when no projectId)
    expect(routesFile).toContain('if (linkedProject)');
  });
});
