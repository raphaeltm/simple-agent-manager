import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('tasks routes source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/routes/tasks/crud.ts'), 'utf8');

  it('defines project-scoped task CRUD and list endpoints', () => {
    expect(file).toContain("crudRoutes.post('/',");
    expect(file).toContain("crudRoutes.get('/',");
    expect(file).toContain("crudRoutes.get('/:taskId',");
    expect(file).toContain("crudRoutes.patch('/:taskId',");
    expect(file).toContain("crudRoutes.delete('/:taskId',");
  });

  it('supports filtering, sorting, and pagination for task lists', () => {
    expect(file).toContain("const requestedStatus = c.req.query('status')");
    expect(file).toContain("const minPriorityQuery = c.req.query('minPriority')");
    expect(file).toContain('parseTaskSortOrder');
    expect(file).toContain('nextCursor');
  });

  it('enforces status transitions with blocked-state guards', () => {
    expect(file).toContain("crudRoutes.post('/:taskId/status',");
    expect(file).toContain('canTransitionTaskStatus');
    expect(file).toContain('isExecutableTaskStatus');
    expect(file).toContain('Task is blocked by unresolved dependencies');
  });

  it('records append-only task status events', () => {
    expect(file).toContain('appendStatusEvent');
    expect(file).toContain('taskStatusEvents');
    expect(file).toContain("crudRoutes.get('/:taskId/events',");
  });

  it('implements dependency management with cycle prevention', () => {
    expect(file).toContain("crudRoutes.post('/:taskId/dependencies',");
    expect(file).toContain("crudRoutes.delete('/:taskId/dependencies',");
    expect(file).toContain('wouldCreateTaskDependencyCycle');
    expect(file).toContain('Task cannot depend on itself');
    expect(file).toContain('Dependency would create a cycle');
  });

  it('implements manual delegation eligibility and workspace ownership checks', () => {
    expect(file).toContain("crudRoutes.post('/:taskId/delegate',");
    expect(file).toContain('Only ready tasks can be delegated');
    expect(file).toContain('Blocked tasks cannot be delegated');
    expect(file).toContain('requireOwnedWorkspace');
    expect(file).toContain("workspace.status !== 'running'");
  });

  it('supports trusted callback status updates for delegated tasks', () => {
    expect(file).toContain("crudRoutes.post('/:taskId/status/callback',");
    expect(file).toContain('verifyCallbackToken');
    expect(file).toContain('Token workspace mismatch');
    expect(file).toContain("'workspace_callback'");
  });
});
