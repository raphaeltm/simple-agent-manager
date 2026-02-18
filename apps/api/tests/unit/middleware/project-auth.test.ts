import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('project-auth middleware helpers', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/middleware/project-auth.ts'), 'utf8');

  it('provides ownership-scoped lookup helpers for projects, tasks, and workspaces', () => {
    expect(file).toContain('requireOwnedProject');
    expect(file).toContain('requireOwnedTask');
    expect(file).toContain('requireOwnedWorkspace');
    expect(file).toContain('errors.notFound');
  });
});
