import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('workspaces routes source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/routes/workspaces.ts'), 'utf8');
  const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');
  const migrationFile = readFileSync(
    resolve(process.cwd(), 'src/db/migrations/0007_multi_workspace_nodes.sql'),
    'utf8'
  );

  it('defines node-scoped workspace list/filter and rename endpoints', () => {
    expect(file).toContain("const nodeId = c.req.query('nodeId')");
    expect(file).toContain("workspacesRoutes.patch('/:id'");
    expect(file).toContain('resolveUniqueWorkspaceDisplayName');
    expect(file).toContain('UpdateWorkspaceRequest');
    expect(file).toContain('body.displayName?.trim()');
    expect(file).toContain('normalizedDisplayName');
  });

  it('defines agent sessions endpoints (events moved to direct VM Agent access)', () => {
    expect(file).not.toContain("workspacesRoutes.get('/:id/events'");
    expect(file).not.toContain('fetchWorkspaceEvents');
    expect(file).toContain("workspacesRoutes.get('/:id/agent-sessions'");
    expect(file).toContain("workspacesRoutes.post('/:id/agent-sessions'");
    expect(file).toContain("workspacesRoutes.post('/:id/agent-sessions/:sessionId/stop'");
  });

  it('uses DB-backed node-scoped unique display names for create and rename', () => {
    expect(file).toContain('const uniqueName = await resolveUniqueWorkspaceDisplayName(db, targetNodeId, workspaceName)');
    expect(file).toContain('resolveUniqueWorkspaceDisplayName(');
    expect(file).toContain('nodeScopeId');
    expect(schemaFile).toContain('idx_workspaces_node_display_name_unique');
    expect(migrationFile).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_node_display_name_unique'
    );
  });

  it('keeps rename and create duplicate protection tied to node scope', () => {
    expect(file).toContain('workspace.id');
    expect(file).toContain('nodeId: nodeScopeId');
    expect(file).toContain('Maximum ${limits.maxWorkspacesPerNode} workspaces allowed per node');
  });

  it('removes idle-triggered request-shutdown route', () => {
    expect(file).not.toContain('/request-shutdown');
  });

  it('accepts node-scoped callback tokens for workspace callbacks', () => {
    expect(file).toContain('payload.workspace === workspace.nodeId');
    expect(file).toContain("throw errors.forbidden('Token workspace mismatch')");
    expect(file).toContain("path.endsWith('/provisioning-failed')");
    expect(file).toContain("workspacesRoutes.post('/:id/provisioning-failed'");
    expect(file).toContain("reason: 'workspace_not_creating'");
  });

  it('supports recovery workspace status for ready callbacks and lifecycle actions', () => {
    expect(file).toContain("const ACTIVE_WORKSPACE_STATUSES = new Set(['running', 'recovery'] as const);");
    expect(file).toContain('function normalizeWorkspaceReadyStatus');
    expect(file).toContain('status: nextStatus');
    expect(file).toContain('Workspace must be running, recovery, or in error state to rebuild');
  });

  it('exposes callback-auth runtime metadata for node recovery', () => {
    expect(file).toContain("path.endsWith('/runtime')");
    expect(file).toContain("path.endsWith('/runtime-assets')");
    expect(file).toContain("workspacesRoutes.get('/:id/runtime'");
    expect(file).toContain("workspacesRoutes.get('/:id/runtime-assets'");
    expect(file).toContain('repository: schema.workspaces.repository');
    expect(file).toContain('branch: schema.workspaces.branch');
  });

  it('waits for newly provisioned node readiness before workspace create dispatch', () => {
    expect(file).toContain('waitForNodeAgentReady');
    expect(file).toContain("provisionedNode.status !== 'running'");
    expect(file).toContain('Node agent not reachable after provisioning');
  });

  it('supports launching workspaces directly from project context', () => {
    expect(file).toContain('const projectId = body.projectId?.trim() || null');
    expect(file).toContain('requireOwnedProject');
    expect(file).toContain('projectId: linkedProject?.id ?? null');
  });
});
