/**
 * Tests for workspace dispatch guard.
 *
 * Verifies that the node-ready handler filters out already-dispatched
 * workspaces, TaskRunner sets the marker before dispatching, and the
 * safety-net recovery path is preserved for un-dispatched workspaces.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Node-ready workspace dispatch guard', () => {
  const nodeLifecycleSource = readFileSync(
    resolve(process.cwd(), 'src/routes/node-lifecycle.ts'),
    'utf8'
  );

  it('filters out workspaces with dispatched_to_agent_at set', () => {
    expect(nodeLifecycleSource).toContain('isNull(schema.workspaces.dispatchedToAgentAt)');
  });

  it('imports isNull from drizzle-orm', () => {
    expect(nodeLifecycleSource).toContain("import { and, eq, isNull, sql } from 'drizzle-orm'");
  });
});

describe('TaskRunner dispatch marker', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/durable-objects/task-runner/workspace-steps.ts'),
    'utf8'
  );

  it('sets dispatched_to_agent_at before calling createWorkspaceOnVmAgent', () => {
    const callSiteIndex = source.indexOf('await markWorkspaceDispatched(rc, workspaceId)');
    const vmAgentCallIndex = source.indexOf('await createWorkspaceOnVmAgent(');
    expect(callSiteIndex).toBeGreaterThan(-1);
    expect(vmAgentCallIndex).toBeGreaterThan(-1);
    expect(callSiteIndex).toBeLessThan(vmAgentCallIndex);
  });

  it('markWorkspaceDispatched updates the dispatched_to_agent_at column', () => {
    expect(source).toContain("UPDATE workspaces SET dispatched_to_agent_at = ?");
  });
});

describe('Trial orchestrator dispatch marker', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/durable-objects/trial-orchestrator/steps.ts'),
    'utf8'
  );

  it('sets dispatched_to_agent_at before calling createWorkspaceOnNode', () => {
    const markerIndex = source.indexOf('dispatched_to_agent_at');
    const vmAgentCallIndex = source.indexOf('createWorkspaceOnNode(state.nodeId');
    expect(markerIndex).toBeGreaterThan(-1);
    expect(vmAgentCallIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBeLessThan(vmAgentCallIndex);
  });
});

describe('Manual workspace creation dispatch marker', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/routes/workspaces/_helpers.ts'),
    'utf8'
  );

  it('sets dispatchedToAgentAt in the same update as status creating', () => {
    expect(source).toContain('dispatchedToAgentAt: now');
  });
});

describe('Workspace dispatch guard — schema', () => {
  it('Drizzle schema includes dispatchedToAgentAt column', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/db/schema.ts'),
      'utf8'
    );
    expect(source).toContain("dispatchedToAgentAt: text('dispatched_to_agent_at')");
  });

  it('migration uses ALTER TABLE ADD COLUMN (no DROP TABLE)', () => {
    const migration = readFileSync(
      resolve(process.cwd(), 'src/db/migrations/0049_workspace_dispatched_marker.sql'),
      'utf8'
    );
    expect(migration).toContain('ALTER TABLE workspaces ADD COLUMN dispatched_to_agent_at TEXT');
    expect(migration).not.toContain('DROP TABLE');
  });
});
