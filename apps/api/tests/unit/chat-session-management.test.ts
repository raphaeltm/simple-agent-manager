/**
 * TDF-6: Chat Session Management — Source contract tests.
 *
 * Validates the four TDF-6 fixes via source code analysis:
 * 1. Single session creation point (task-submit only, not task-runner DO)
 * 2. No fallback session IDs (sess-fallback-* pattern eliminated)
 * 3. Workspace-session linking via linkSessionToWorkspace RPC
 * 4. Required (not best-effort) session creation and message persistence
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const taskSubmitSource = readFileSync(
  resolve(process.cwd(), 'src/routes/task-submit.ts'),
  'utf8'
);
const taskRunnerDoSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
  'utf8'
);
const projectDataDoSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/project-data.ts'),
  'utf8'
);
const projectDataServiceSource = readFileSync(
  resolve(process.cwd(), 'src/services/project-data.ts'),
  'utf8'
);
const taskRunnerDoServiceSource = readFileSync(
  resolve(process.cwd(), 'src/services/task-runner-do.ts'),
  'utf8'
);

// =========================================================================
// Fix 1: Single session creation — no duplicate sessions per task
// =========================================================================

describe('TDF-6 Fix 1: Single session creation point', () => {
  it('task-submit creates session via projectDataService.createSession', () => {
    expect(taskSubmitSource).toContain('projectDataService.createSession(');
  });

  it('task-submit creates session with workspaceId=null (linked later)', () => {
    expect(taskSubmitSource).toContain(
      'null, // workspaceId — linked later by TaskRunner DO when workspace is created'
    );
  });

  it('TaskRunner DO does NOT call createSession in handleWorkspaceCreation', () => {
    // Extract the handleWorkspaceCreation method
    const wsCreationStart = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceCreation('
    );
    const wsCreationEnd = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceReady('
    );
    const wsCreationSection = taskRunnerDoSource.slice(wsCreationStart, wsCreationEnd);

    expect(wsCreationSection).not.toContain('createSession(');
    expect(wsCreationSection).not.toContain('projectDataService.createSession');
  });

  it('TaskRunner DO calls linkSessionToWorkspace instead of createSession', () => {
    const wsCreationStart = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceCreation('
    );
    const wsCreationEnd = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceReady('
    );
    const wsCreationSection = taskRunnerDoSource.slice(wsCreationStart, wsCreationEnd);

    expect(wsCreationSection).toContain('linkSessionToWorkspace');
  });

  it('task-submit passes sessionId to TaskRunner DO via chatSessionId', () => {
    expect(taskSubmitSource).toContain('chatSessionId: sessionId');
  });

  it('TaskRunner DO receives chatSessionId in config', () => {
    expect(taskRunnerDoSource).toContain('chatSessionId: string | null');
  });

  it('TaskRunner DO initializes stepResults.chatSessionId from config', () => {
    expect(taskRunnerDoSource).toContain(
      'chatSessionId: input.config.chatSessionId ?? null'
    );
  });
});

// =========================================================================
// Fix 2: No fallback session IDs
// =========================================================================

describe('TDF-6 Fix 2: No fallback session IDs', () => {
  it('task-submit does NOT contain sess-fallback pattern', () => {
    expect(taskSubmitSource).not.toContain('sess-fallback');
  });

  it('task-submit does NOT have try-catch around session creation', () => {
    // Session creation should be a direct await, not wrapped in try-catch
    // Find the createSession call and verify it's not inside a catch block
    const sessionCreateLine = taskSubmitSource.indexOf('projectDataService.createSession(');
    const nearbyCode = taskSubmitSource.slice(
      Math.max(0, sessionCreateLine - 200),
      sessionCreateLine
    );
    expect(nearbyCode).not.toContain('try {');
    expect(nearbyCode).not.toContain('catch');
  });

  it('session creation uses const (required, single assignment)', () => {
    expect(taskSubmitSource).toContain('const sessionId = await projectDataService.createSession(');
  });

  it('no fallback ID generation anywhere in task-submit', () => {
    expect(taskSubmitSource).not.toContain('`sess-fallback-');
    expect(taskSubmitSource).not.toContain("'sess-fallback-");
    expect(taskSubmitSource).not.toContain('"sess-fallback-');
  });

  it('task-submit does NOT have best-effort comment for session creation', () => {
    // Find the session creation area and check it's not marked best-effort
    const sessionArea = taskSubmitSource.slice(
      taskSubmitSource.indexOf('Create chat session'),
      taskSubmitSource.indexOf('Persist initial user message')
    );
    expect(sessionArea).not.toContain('best-effort');
    expect(sessionArea).toContain('REQUIRED');
  });
});

// =========================================================================
// Fix 3: Workspace-session linking
// =========================================================================

describe('TDF-6 Fix 3: Workspace-session linking', () => {
  it('ProjectData DO has linkSessionToWorkspace method', () => {
    expect(projectDataDoSource).toContain(
      'async linkSessionToWorkspace('
    );
  });

  it('linkSessionToWorkspace accepts sessionId and workspaceId', () => {
    expect(projectDataDoSource).toContain(
      'sessionId: string,\n    workspaceId: string'
    );
  });

  it('linkSessionToWorkspace validates session exists', () => {
    const linkMethod = projectDataDoSource.slice(
      projectDataDoSource.indexOf('async linkSessionToWorkspace('),
      projectDataDoSource.indexOf('async listSessions(')
    );
    expect(linkMethod).toContain('Session ${sessionId} not found');
  });

  it('linkSessionToWorkspace updates workspace_id on the session', () => {
    const linkMethod = projectDataDoSource.slice(
      projectDataDoSource.indexOf('async linkSessionToWorkspace('),
      projectDataDoSource.indexOf('async listSessions(')
    );
    expect(linkMethod).toContain('UPDATE chat_sessions SET workspace_id = ?');
  });

  it('linkSessionToWorkspace broadcasts session.updated event', () => {
    const linkMethod = projectDataDoSource.slice(
      projectDataDoSource.indexOf('async linkSessionToWorkspace('),
      projectDataDoSource.indexOf('async listSessions(')
    );
    expect(linkMethod).toContain("broadcastEvent('session.updated'");
  });

  it('project-data service exports linkSessionToWorkspace wrapper', () => {
    expect(projectDataServiceSource).toContain(
      'export async function linkSessionToWorkspace('
    );
  });

  it('service wrapper calls DO stub.linkSessionToWorkspace', () => {
    expect(projectDataServiceSource).toContain(
      'stub.linkSessionToWorkspace(sessionId, workspaceId)'
    );
  });

  it('TaskRunner DO updates workspace.chatSessionId in D1 with existing sessionId', () => {
    const wsCreationStart = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceCreation('
    );
    const wsCreationEnd = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceReady('
    );
    const wsCreationSection = taskRunnerDoSource.slice(wsCreationStart, wsCreationEnd);

    // The section should reference the existing chatSessionId from state
    expect(wsCreationSection).toContain('state.stepResults.chatSessionId');
    expect(wsCreationSection).toContain(
      'UPDATE workspaces SET chat_session_id = ?'
    );
  });

  it('TaskRunner DO session linking is best-effort (does not block task)', () => {
    const wsCreationStart = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceCreation('
    );
    const wsCreationEnd = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceReady('
    );
    const wsCreationSection = taskRunnerDoSource.slice(wsCreationStart, wsCreationEnd);

    // Linking should be wrapped in try-catch (best-effort)
    expect(wsCreationSection).toContain('session_link_failed');
    expect(wsCreationSection).toContain('best-effort');
  });
});

// =========================================================================
// Fix 4: Required message persistence
// =========================================================================

describe('TDF-6 Fix 4: Required session and message persistence', () => {
  it('task-submit persists initial message as REQUIRED', () => {
    const messageArea = taskSubmitSource.slice(
      taskSubmitSource.indexOf('Persist initial user message'),
      taskSubmitSource.indexOf('Record activity event')
    );
    expect(messageArea).toContain('REQUIRED');
    expect(messageArea).not.toContain('best-effort');
  });

  it('initial message persistence is a direct await (no try-catch)', () => {
    // Find the persistMessage call and verify it's not wrapped in catch
    const persistLine = taskSubmitSource.indexOf(
      'await projectDataService.persistMessage('
    );
    const nearbyCode = taskSubmitSource.slice(
      Math.max(0, persistLine - 200),
      persistLine
    );
    // The only try-catch should be gone; the await should be at the top level
    expect(nearbyCode).not.toContain('try {');
  });

  it('no error logging for message persistence failure (propagates naturally)', () => {
    // The old code had task_submit.message_persist_failed — should be removed
    expect(taskSubmitSource).not.toContain('task_submit.message_persist_failed');
  });

  it('no error logging for session creation failure (propagates naturally)', () => {
    expect(taskSubmitSource).not.toContain('task_submit.session_create_failed');
  });
});

// =========================================================================
// TaskRunner DO service passes chatSessionId
// =========================================================================

describe('TDF-6: TaskRunner DO service chatSessionId passthrough', () => {
  it('startTaskRunnerDO input type includes chatSessionId', () => {
    expect(taskRunnerDoServiceSource).toContain('chatSessionId');
  });

  it('startTaskRunnerDO passes chatSessionId in config', () => {
    expect(taskRunnerDoServiceSource).toContain(
      'chatSessionId: input.chatSessionId ?? null'
    );
  });

  it('TaskRunConfig interface includes chatSessionId field', () => {
    // Find the TaskRunConfig interface
    const configStart = taskRunnerDoSource.indexOf('interface TaskRunConfig {');
    const configEnd = taskRunnerDoSource.indexOf('}', configStart);
    const configSection = taskRunnerDoSource.slice(configStart, configEnd);

    expect(configSection).toContain('chatSessionId: string | null');
  });
});
