import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const crudSource = readFileSync(resolve(process.cwd(), 'src/routes/tasks/crud.ts'), 'utf8');
const runSource = readFileSync(resolve(process.cwd(), 'src/routes/tasks/run.ts'), 'utf8');

function routeBlock(source: string, marker: string, endMarker: string): string {
  const start = source.indexOf(marker);
  expect(start, `missing marker ${marker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + marker.length);
  expect(end, `missing end marker ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('shared project task authorization lookup consistency', () => {
  it('run uses project-authorized task lookup for owner-created tasks but caller-scoped credentials and identity', () => {
    const block = routeBlock(runSource, "runRoutes.post('/:taskId/run'", "runRoutes.post('/:taskId/run/cleanup'");

    expect(block).toContain("requireProjectCapability(db, projectId, userId, 'task:write')");
    expect(block).toContain('const task = await requireProjectTaskById(db, projectId, taskId)');
    expect(block).not.toContain('requireOwnedTask(db, projectId, taskId, userId)');

    expect(block).toContain('eq(schema.credentials.userId, userId)');
    expect(block).toContain('requireRepositoryUserAccess(c, db, project, userId)');
    expect(block).toContain('userId,');
    expect(block).toContain("eq(schema.tasks.projectId, projectId)");
    expect(block).not.toContain("eq(schema.tasks.userId, userId)");
  });

  it('manual terminal cleanup uses project-authorized task lookup and preserves terminal-state guard', () => {
    const block = routeBlock(runSource, "runRoutes.post('/:taskId/run/cleanup'", 'export { runRoutes }');

    expect(block).toContain("requireProjectCapability(db, projectId, userId, 'task:write')");
    expect(block).toContain('const task = await requireProjectTaskById(db, projectId, taskId)');
    expect(block).not.toContain('requireOwnedTask(db, projectId, taskId, userId)');
    expect(block).toContain("task.status !== 'completed'");
    expect(block).toContain("task.status !== 'failed'");
    expect(block).toContain("task.status !== 'cancelled'");
    expect(block).toContain('cleanupTaskRun(task.id, c.env)');
  });

  it('delegate uses project-authorized task lookup but requires a caller-owned running workspace', () => {
    const block = routeBlock(crudSource, "crudRoutes.post('/:taskId/delegate'", "crudRoutes.get('/:taskId/events'");

    expect(block).toContain("requireProjectCapability(db, projectId, userId, 'task:write')");
    expect(block).toContain('const task = await requireProjectTaskById(db, projectId, taskId)');
    expect(block).not.toContain('requireOwnedTask(db, projectId, taskId, userId)');
    expect(block).toContain('const workspace = await requireOwnedWorkspace(db, workspaceId, userId)');
    expect(block).toContain("workspace.status !== 'running'");
  });

  it('conversation close uses project-authorized task lookup without deleting another user workspace', () => {
    const block = routeBlock(crudSource, "crudRoutes.post('/:taskId/close'", "crudRoutes.get('/:taskId/sessions'");

    expect(block).toContain("requireProjectCapability(db, projectId, userId, 'task:write')");
    expect(block).toContain('const task = await requireProjectTaskById(db, projectId, taskId)');
    expect(block).not.toContain('requireOwnedTaskById(db, taskId, userId)');
    expect(block).toContain("task.taskMode !== 'conversation'");
    expect(block).toContain("const closableStatuses: TaskStatus[] = ['in_progress', 'delegated']");
    expect(block).toContain('eq(schema.workspaces.id, task.workspaceId)');
    expect(block).toContain('eq(schema.workspaces.userId, userId)');
    expect(block).toContain('eq(schema.workspaces.projectId, projectId)');
    expect(block).toContain('cleanupWorkspaceForDeletion');
  });
});

