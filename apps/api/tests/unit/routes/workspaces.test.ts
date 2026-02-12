import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('workspaces routes source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/routes/workspaces.ts'), 'utf8');
  const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');
  const migrationFile = readFileSync(resolve(process.cwd(), 'src/db/migrations/0007_multi_workspace_nodes.sql'), 'utf8');

  it('defines node-scoped workspace list/filter and rename endpoints', () => {
    expect(file).toContain("const nodeId = c.req.query('nodeId')");
    expect(file).toContain("workspacesRoutes.patch('/:id'");
    expect(file).toContain('resolveUniqueWorkspaceDisplayName');
    expect(file).toContain('UpdateWorkspaceRequest');
    expect(file).toContain('body.displayName?.trim()');
    expect(file).toContain('normalizedDisplayName');
  });

  it('defines workspace events and agent sessions endpoints', () => {
    expect(file).toContain("workspacesRoutes.get('/:id/events'");
    expect(file).toContain("workspacesRoutes.get('/:id/agent-sessions'");
    expect(file).toContain("workspacesRoutes.post('/:id/agent-sessions'");
    expect(file).toContain("workspacesRoutes.post('/:id/agent-sessions/:sessionId/stop'");
  });

  it('implements idempotent session creation support', () => {
    expect(file).toContain("c.req.header('Idempotency-Key')");
    expect(file).toContain('agent-session-idempotency');
  });

  it('uses DB-backed node-scoped unique display names for create and rename', () => {
    expect(file).toContain('const uniqueName = await resolveUniqueWorkspaceDisplayName(db, targetNodeId, body.name)');
    expect(file).toContain('resolveUniqueWorkspaceDisplayName(');
    expect(file).toContain('nodeScopeId');
    expect(schemaFile).toContain('idx_workspaces_node_display_name_unique');
    expect(migrationFile).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_node_display_name_unique');
  });

  it('keeps rename and create duplicate protection tied to node scope', () => {
    expect(file).toContain('workspace.id');
    expect(file).toContain('nodeId: nodeScopeId');
    expect(file).toContain('Maximum ${limits.maxWorkspacesPerNode} workspaces allowed per node');
  });

  it('removes idle-triggered request-shutdown route', () => {
    expect(file).not.toContain('/request-shutdown');
  });
});
