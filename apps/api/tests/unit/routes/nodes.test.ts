import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('nodes routes source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/routes/nodes.ts'), 'utf8');
  const limitsFile = readFileSync(resolve(process.cwd(), 'src/services/limits.ts'), 'utf8');

  it('defines CRUD and lifecycle endpoints', () => {
    expect(file).toContain("nodesRoutes.get('/',");
    expect(file).toContain("nodesRoutes.post('/',");
    expect(file).toContain("nodesRoutes.get('/:id',");
    expect(file).toContain("nodesRoutes.post('/:id/stop',");
    expect(file).toContain("nodesRoutes.delete('/:id',");
  });

  it('defines node callback and token endpoints', () => {
    expect(file).toContain("nodesRoutes.post('/:id/token',");
    expect(file).toContain("nodesRoutes.post('/:id/ready',");
    expect(file).toContain("nodesRoutes.post('/:id/heartbeat',");
    expect(file).toContain('createWorkspaceOnNode');
    expect(file).toContain('signCallbackToken');
    expect(file).toContain("eq(schema.workspaces.status, 'creating')");
  });

  it('proxies node events from VM Agent (vm-* DNS records lack SSL termination)', () => {
    expect(file).toContain("nodesRoutes.get('/:id/events',");
    expect(file).toContain('listNodeEventsOnNode');
    expect(file).toContain('signNodeManagementToken');
  });

  it('implements stop/delete semantics for child workspaces and sessions', () => {
    expect(file).toContain('stopWorkspaceOnNode');
    expect(file).toContain("workspace.status === 'running' || workspace.status === 'recovery' || workspace.status === 'creating'");
    expect(file).toContain('.delete(schema.agentSessions)');
    expect(file).toContain('.delete(schema.workspaces)');
    expect(file).toContain('.delete(schema.nodes)');
  });

  it('contains heartbeat health transition logic', () => {
    expect(file).toContain('deriveHealthStatus');
    expect(file).toContain('staleThreshold');
    expect(file).toContain("if (ageSeconds <= staleThreshold * 2)");
    expect(file).toContain("return 'healthy'");
    expect(file).toContain("return 'stale'");
    expect(file).toContain("return 'unhealthy'");
    expect(limitsFile).toContain('NODE_HEARTBEAT_STALE_SECONDS');
  });
});
