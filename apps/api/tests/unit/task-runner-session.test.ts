/**
 * Source contract tests for task runner chat session creation (T031).
 *
 * Verifies that executeTaskRun creates a chat session in the ProjectData DO
 * with the correct taskId, stores chatSessionId on the workspace, and sets
 * output_branch to task/{taskId} format.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('task runner chat session creation source contract', () => {
  const taskRunnerFile = readFileSync(resolve(process.cwd(), 'src/services/task-runner.ts'), 'utf8');
  const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');

  it('creates chat session with correct taskId and title', () => {
    expect(taskRunnerFile).toContain('projectDataService.createSession');
    expect(taskRunnerFile).toContain('project.id');
    expect(taskRunnerFile).toContain('task.title');
    expect(taskRunnerFile).toContain('task.id // taskId');
  });

  it('stores chatSessionId on workspace record', () => {
    expect(taskRunnerFile).toContain('set({ chatSessionId');
    expect(schemaFile).toContain("chatSessionId: text('chat_session_id')");
  });

  it('sets output_branch to task/{taskId} format', () => {
    expect(taskRunnerFile).toContain('`task/${task.id}`');
    expect(taskRunnerFile).toContain('outputBranch');
  });

  it('session creation failure does not block workspace creation (best-effort)', () => {
    expect(taskRunnerFile).toContain('Failed to create chat session for task workspace');
    // Wrapped in try/catch
    expect(taskRunnerFile).toContain('} catch (err) {');
  });

  it('imports projectDataService for session creation', () => {
    expect(taskRunnerFile).toContain("import * as projectDataService from './project-data'");
  });

  it('chat session creation happens before workspace provisioning on node', () => {
    // createSession should appear before createWorkspaceOnNode in the code
    const sessionIdx = taskRunnerFile.indexOf('projectDataService.createSession');
    const workspaceOnNodeIdx = taskRunnerFile.indexOf('createWorkspaceOnNode(nodeId');
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(workspaceOnNodeIdx).toBeGreaterThan(-1);
    expect(sessionIdx).toBeLessThan(workspaceOnNodeIdx);
  });
});
