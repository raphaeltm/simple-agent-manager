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
const taskRunsSource = readFileSync(
  resolve(process.cwd(), 'src/routes/task-runs.ts'),
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

  it('TaskRunner DO calls ensureSessionLinked (which calls linkSessionToWorkspace)', () => {
    const wsCreationStart = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceCreation('
    );
    const wsCreationEnd = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceReady('
    );
    const wsCreationSection = taskRunnerDoSource.slice(wsCreationStart, wsCreationEnd);

    // handleWorkspaceCreation delegates to ensureSessionLinked
    expect(wsCreationSection).toContain('ensureSessionLinked');
    // ensureSessionLinked calls linkSessionToWorkspace
    expect(taskRunnerDoSource).toContain('linkSessionToWorkspace');
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

  it('task-submit wraps session creation in try-catch that fails the task on error', () => {
    // Session creation failure should mark the task as failed (not orphan it)
    expect(taskSubmitSource).toContain('Session creation failed:');
    expect(taskSubmitSource).toContain("status: 'failed'");
  });

  it('session creation uses let with try-catch for error cleanup', () => {
    expect(taskSubmitSource).toContain('sessionId = await projectDataService.createSession(');
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

  it('task-submit marks task as failed if DO startup fails', () => {
    expect(taskSubmitSource).toContain('Task runner startup failed:');
    expect(taskSubmitSource).toContain('task_submit.do_startup_failed');
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

  it('TaskRunner DO updates workspace.chatSessionId via ensureSessionLinked', () => {
    // The D1 update is in ensureSessionLinked (called from handleWorkspaceCreation)
    expect(taskRunnerDoSource).toContain('UPDATE workspaces SET chat_session_id = ?');
    expect(taskRunnerDoSource).toContain('state.stepResults.chatSessionId');

    // handleWorkspaceCreation calls ensureSessionLinked
    const wsCreationStart = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceCreation('
    );
    const wsCreationEnd = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceReady('
    );
    const wsCreationSection = taskRunnerDoSource.slice(wsCreationStart, wsCreationEnd);
    expect(wsCreationSection).toContain('this.ensureSessionLinked(');
  });

  it('TaskRunner DO has separate D1 and DO session linking via ensureSessionLinked', () => {
    // Session linking is now in a dedicated helper method (ensureSessionLinked)
    // that is called from both fresh creation and crash recovery paths.
    expect(taskRunnerDoSource).toContain('private async ensureSessionLinked(');
    expect(taskRunnerDoSource).toContain('session_d1_linked');
    expect(taskRunnerDoSource).toContain('session_d1_link_failed');
    expect(taskRunnerDoSource).toContain('session_linked_to_workspace');
    expect(taskRunnerDoSource).toContain('session_do_link_failed');
  });

  it('handleWorkspaceCreation calls ensureSessionLinked', () => {
    const wsCreationStart = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceCreation('
    );
    const wsCreationEnd = taskRunnerDoSource.indexOf(
      'private async handleWorkspaceReady('
    );
    const wsCreationSection = taskRunnerDoSource.slice(wsCreationStart, wsCreationEnd);

    // Both fresh creation and crash recovery call ensureSessionLinked
    const calls = wsCreationSection.split('ensureSessionLinked').length - 1;
    expect(calls).toBeGreaterThanOrEqual(2); // once in recovery, once in fresh creation
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

  it('message persistence failure marks task as failed (not silently dropped)', () => {
    // The old code silently swallowed errors. Now session creation + message
    // persistence failures mark the task as failed and re-throw.
    expect(taskSubmitSource).toContain('Session creation failed:');
    expect(taskSubmitSource).toContain('task_submit.session_failed');
  });

  it('no old-style error logging for message persistence failure', () => {
    // The old code had task_submit.message_persist_failed — should be removed
    expect(taskSubmitSource).not.toContain('task_submit.message_persist_failed');
  });

  it('no old-style error logging for session creation failure', () => {
    expect(taskSubmitSource).not.toContain('task_submit.session_create_failed');
  });
});

// =========================================================================
// Fix 5: task-runs.ts route creates session (regression prevention)
// =========================================================================

describe('TDF-6 Fix 5: task-runs route creates session (no regression)', () => {
  it('task-runs imports projectDataService', () => {
    expect(taskRunsSource).toContain("import * as projectDataService from '../services/project-data'");
  });

  it('task-runs creates a session via projectDataService.createSession', () => {
    expect(taskRunsSource).toContain('projectDataService.createSession(');
  });

  it('task-runs passes chatSessionId to startTaskRunnerDO', () => {
    expect(taskRunsSource).toContain('chatSessionId: sessionId');
  });

  it('task-runs does NOT contain sess-fallback pattern', () => {
    expect(taskRunsSource).not.toContain('sess-fallback');
  });

  it('task-runs marks task as failed if session creation fails', () => {
    expect(taskRunsSource).toContain('Session creation failed:');
    expect(taskRunsSource).toContain('task_run.session_failed');
  });

  it('task-runs marks task as failed if DO startup fails', () => {
    expect(taskRunsSource).toContain('Task runner startup failed:');
    expect(taskRunsSource).toContain('task_run.do_startup_failed');
  });

  it('task-runs creates session with workspaceId=null (linked later)', () => {
    expect(taskRunsSource).toContain(
      'null, // workspaceId — linked later by TaskRunner DO when workspace is created'
    );
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
