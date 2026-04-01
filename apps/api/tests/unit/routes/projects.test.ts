import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('projects routes source contract', () => {
  const indexFile = readFileSync(resolve(process.cwd(), 'src/routes/projects/index.ts'), 'utf8');
  const crudFile = readFileSync(resolve(process.cwd(), 'src/routes/projects/crud.ts'), 'utf8');
  const helpersFile = readFileSync(resolve(process.cwd(), 'src/routes/projects/_helpers.ts'), 'utf8');
  const file = indexFile + '\n' + crudFile + '\n' + helpersFile;

  it('defines authenticated CRUD endpoints for projects', () => {
    expect(file).toContain("projectsRoutes.use('/*', requireAuth(), requireApproved())");
    expect(file).toContain("crudRoutes.post('/',");
    expect(file).toContain("crudRoutes.get('/',");
    expect(file).toContain("crudRoutes.get('/:id',");
    expect(file).toContain("crudRoutes.get('/:id/runtime-config'");
    expect(file).toContain("crudRoutes.post('/:id/runtime/env-vars'");
    expect(file).toContain("crudRoutes.delete('/:id/runtime/env-vars/:envKey'");
    expect(file).toContain("crudRoutes.post('/:id/runtime/files'");
    expect(file).toContain("crudRoutes.delete('/:id/runtime/files'");
    expect(file).toContain("crudRoutes.patch('/:id',");
    expect(file).toContain("crudRoutes.delete('/:id',");
  });

  it('enforces normalized name uniqueness and per-user project limits', () => {
    expect(file).toContain('normalizeProjectName');
    expect(file).toContain('maxProjectsPerUser');
    expect(file).toContain('Project name must be unique per user');
  });

  it('validates installation ownership and repository access on create/update', () => {
    expect(file).toContain('requireOwnedInstallation');
    expect(file).toContain('assertRepositoryAccess');
    expect(file).toContain('Repository is not accessible through the selected installation');
  });

  it('returns project detail summaries with task counts and linked workspace count', () => {
    expect(file).toContain('taskCountsByStatus');
    expect(file).toContain('linkedWorkspaces');
    expect(file).toContain('count(distinct');
  });

  it('supports cursor pagination for project listing', () => {
    expect(file).toContain("const cursor = c.req.query('cursor')");
    expect(file).toContain('nextCursor');
    expect(file).toContain('limit + 1');
  });

  it('stores project runtime secrets encrypted and masks them in responses', () => {
    expect(file).toContain('buildProjectRuntimeConfigResponse');
    expect(file).toContain('await encrypt(');
    expect(file).toContain('if (row.isSecret)');
    expect(file).toContain('value = null');
    expect(file).toContain('content = null');
  });

  it('validates workspace and node idle timeout bounds on PATCH', () => {
    // workspaceIdleTimeoutMs validation
    expect(crudFile).toContain('body.workspaceIdleTimeoutMs');
    expect(crudFile).toContain('MIN_WORKSPACE_IDLE_TIMEOUT_MS');
    expect(crudFile).toContain('MAX_WORKSPACE_IDLE_TIMEOUT_MS');
    expect(crudFile).toContain('workspaceIdleTimeoutMs must be between');

    // nodeIdleTimeoutMs validation
    expect(crudFile).toContain('body.nodeIdleTimeoutMs');
    expect(crudFile).toContain('MIN_NODE_IDLE_TIMEOUT_MS');
    expect(crudFile).toContain('MAX_NODE_IDLE_TIMEOUT_MS');
    expect(crudFile).toContain('nodeIdleTimeoutMs must be between');
  });

  it('allows null to clear idle timeout settings (revert to platform default)', () => {
    // null values bypass validation and clear the setting
    expect(crudFile).toContain('body.workspaceIdleTimeoutMs !== undefined && body.workspaceIdleTimeoutMs !== null');
    expect(crudFile).toContain('body.nodeIdleTimeoutMs !== undefined && body.nodeIdleTimeoutMs !== null');
    // null coalescing persists null to DB
    expect(crudFile).toContain('body.workspaceIdleTimeoutMs ?? null');
    expect(crudFile).toContain('body.nodeIdleTimeoutMs ?? null');
  });
});
