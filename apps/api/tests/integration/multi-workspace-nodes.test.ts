import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('multi-workspace nodes integration wiring', () => {
  const nodesRoute = readFileSync(resolve(process.cwd(), 'src/routes/nodes.ts'), 'utf8');
  const workspacesRoute = readFileSync(resolve(process.cwd(), 'src/routes/workspaces.ts'), 'utf8');
  const indexFile = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

  it('wires node and workspace routes into API index', () => {
    expect(indexFile).toContain("app.route('/api/nodes', nodesRoutes)");
    expect(indexFile).toContain("app.route('/api/workspaces', workspacesRoutes)");
  });

  it('includes cross-component proxy + node-agent call paths', () => {
    expect(indexFile).toContain('ws_proxy_route');
    expect(workspacesRoute).toContain('createWorkspaceOnNode');
    expect(workspacesRoute).toContain('stopWorkspaceOnNode');
    expect(nodesRoute).toContain('stopWorkspaceOnNode');
  });

  it('includes worktreePath handling for agent sessions', () => {
    expect(workspacesRoute).toContain('worktreePath: body.worktreePath?.trim() || null');
    expect(workspacesRoute).toContain('worktreePath: session.worktreePath');
  });
});
