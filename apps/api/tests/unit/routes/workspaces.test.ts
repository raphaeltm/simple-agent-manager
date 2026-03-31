import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('workspaces routes source contract', () => {
  const file = [
    readFileSync(resolve(process.cwd(), 'src/routes/workspaces/_helpers.ts'), 'utf8'),
    readFileSync(resolve(process.cwd(), 'src/routes/workspaces/crud.ts'), 'utf8'),
    readFileSync(resolve(process.cwd(), 'src/routes/workspaces/lifecycle.ts'), 'utf8'),
    readFileSync(resolve(process.cwd(), 'src/routes/workspaces/agent-sessions.ts'), 'utf8'),
    readFileSync(resolve(process.cwd(), 'src/routes/workspaces/runtime.ts'), 'utf8'),
  ].join('\n');
  const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');
  const migrationFile = readFileSync(
    resolve(process.cwd(), 'src/db/migrations/0007_multi_workspace_nodes.sql'),
    'utf8'
  );

  it('defines node-scoped workspace list/filter and rename endpoints', () => {
    expect(file).toContain("const nodeId = c.req.query('nodeId')");
    expect(file).toContain("crudRoutes.patch('/:id'");
    expect(file).toContain('resolveUniqueWorkspaceDisplayName');
    expect(file).toContain("c.req.valid('json')");
    expect(file).toContain('body.displayName?.trim()');
    expect(file).toContain('normalizedDisplayName');
  });

  it('defines agent sessions endpoints (events moved to direct VM Agent access)', () => {
    expect(file).not.toContain("crudRoutes.get('/:id/events'");
    expect(file).not.toContain('fetchWorkspaceEvents');
    expect(file).toContain("agentSessionRoutes.get('/:id/agent-sessions'");
    expect(file).toContain("agentSessionRoutes.post('/:id/agent-sessions'");
    expect(file).toContain("agentSessionRoutes.post('/:id/agent-sessions/:sessionId/stop'");
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
  });

  it('removes idle-triggered request-shutdown route', () => {
    expect(file).not.toContain('/request-shutdown');
  });

  it('accepts node-scoped callback tokens for workspace callbacks', () => {
    expect(file).toContain('payload.workspace === workspace.nodeId');
    expect(file).toContain("throw errors.forbidden('Insufficient token scope')");
    expect(file).toContain("lifecycleRoutes.post('/:id/provisioning-failed'");
    expect(file).toContain("reason: 'workspace_not_creating'");
  });

  it('supports recovery workspace status for ready callbacks and lifecycle actions', () => {
    expect(file).toContain("const ACTIVE_WORKSPACE_STATUSES = new Set(['running', 'recovery'] as const);");
    expect(file).toContain('function normalizeWorkspaceReadyStatus');
    expect(file).toContain('status: nextStatus');
    expect(file).toContain('Workspace must be running, recovery, or in error state to rebuild');
  });

  it('exposes callback-auth runtime metadata for node recovery', () => {
    expect(file).toContain("runtimeRoutes.get('/:id/runtime'");
    expect(file).toContain("runtimeRoutes.get('/:id/runtime-assets'");
    expect(file).toContain('repository: schema.workspaces.repository');
    expect(file).toContain('branch: schema.workspaces.branch');
  });

  it('waits for newly provisioned node readiness before workspace create dispatch', () => {
    expect(file).toContain('waitForNodeAgentReady');
    expect(file).toContain("provisionedNode.status !== 'running'");
    expect(file).toContain('Node agent not reachable after provisioning');
  });

  it('requires projectId on workspace creation and rejects unlinked workspaces', () => {
    // projectId is now required — no more optional chaining with fallback to null
    expect(file).toContain("const projectId = body.projectId?.trim()");
    expect(file).toContain("throw errors.badRequest('projectId is required')");
    expect(file).toContain('requireOwnedProject');
  });

  it('excludes deleted workspaces from list endpoint by default', () => {
    expect(file).toContain("ne(schema.workspaces.status, 'deleted')");
  });

  it('filters node count by active status when checking MAX_NODES_PER_USER', () => {
    // The node count query must only count active nodes — not deleted/stopped ones.
    // See: 2026-03-09-fix-node-workspace-limit-count-filters
    expect(file).toContain("inArray(schema.nodes.status, ['running', 'creating', 'recovery'])");
  });

  it('clears boot logs from KV on restart before new provisioning', () => {
    expect(file).toContain("lifecycleRoutes.post('/:id/restart'");
    expect(file).toContain('writeBootLogs(c.env.KV, workspace.id, [], c.env)');
    // Restart clears errorMessage in DB update
    expect(file).toContain('errorMessage: null');
  });

  it('clears boot logs from KV on rebuild before new provisioning', () => {
    expect(file).toContain("lifecycleRoutes.post('/:id/rebuild'");
    expect(file).toContain('writeBootLogs(c.env.KV, workspace.id, [], c.env)');
  });

  it('stops chat session when workspace is stopped', () => {
    expect(file).toContain('projectDataService.stopSession');
    expect(file).toContain('workspace.stop_session_failed');
  });

  it('stops chat session when workspace is deleted', () => {
    expect(file).toContain('workspace.delete_stop_session_failed');
  });

  it('cleans up workspace activity on stop and delete', () => {
    expect(file).toContain('projectDataService.cleanupWorkspaceActivity');
    expect(file).toContain('workspace.cleanup_activity_failed');
    expect(file).toContain('workspace.delete_cleanup_activity_failed');
  });
});
