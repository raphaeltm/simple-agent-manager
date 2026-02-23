import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('projects routes source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/routes/projects.ts'), 'utf8');

  it('defines authenticated CRUD endpoints for projects', () => {
    expect(file).toContain("projectsRoutes.use('/*', requireAuth(), requireApproved())");
    expect(file).toContain("projectsRoutes.post('/',");
    expect(file).toContain("projectsRoutes.get('/',");
    expect(file).toContain("projectsRoutes.get('/:id',");
    expect(file).toContain("projectsRoutes.get('/:id/runtime-config'");
    expect(file).toContain("projectsRoutes.post('/:id/runtime/env-vars'");
    expect(file).toContain("projectsRoutes.delete('/:id/runtime/env-vars/:envKey'");
    expect(file).toContain("projectsRoutes.post('/:id/runtime/files'");
    expect(file).toContain("projectsRoutes.delete('/:id/runtime/files'");
    expect(file).toContain("projectsRoutes.patch('/:id',");
    expect(file).toContain("projectsRoutes.delete('/:id',");
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
});
