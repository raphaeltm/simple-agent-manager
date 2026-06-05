/**
 * Integration source-contract tests for workspace dispatch idempotency.
 *
 * Verifies the control-plane handoff marker that prevents TaskRunner/UI
 * dispatch paths and node-ready replay from POSTing /workspaces twice for the
 * same workspace.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const schemaSource = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');
const nodeLifecycleSource = readFileSync(resolve(process.cwd(), 'src/routes/node-lifecycle.ts'), 'utf8');
const taskRunnerWorkspaceSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner/workspace-steps.ts'),
  'utf8'
);
const workspaceHelpersSource = readFileSync(resolve(process.cwd(), 'src/routes/workspaces/_helpers.ts'), 'utf8');
const migrationSource = readFileSync(
  resolve(process.cwd(), 'src/db/migrations/0050_workspace_dispatched_at.sql'),
  'utf8'
);

function sectionAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Missing marker: ${marker}`);
  }
  return source.slice(start);
}

function sectionBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Missing start marker: ${startMarker}`);
  }
  const end = source.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error(`Missing end marker: ${endMarker}`);
  }
  return source.slice(start, end);
}

describe('workspace dispatch race prevention', () => {
  it('adds nullable dispatched_at to the workspaces table', () => {
    expect(migrationSource.trim()).toBe('ALTER TABLE workspaces ADD COLUMN dispatched_at TEXT;');
    expect(schemaSource).toContain("dispatchedAt: text('dispatched_at')");
  });

  it('ready handler does not re-dispatch workspaces that already have dispatched_at set', () => {
    const replayQuery = sectionAfter(nodeLifecycleSource, 'const pendingWorkspaces = await innerDb');

    expect(nodeLifecycleSource).toContain("import { and, eq, isNull, sql } from 'drizzle-orm'");
    expect(replayQuery).toContain('eq(schema.workspaces.nodeId, nodeId)');
    expect(replayQuery).toContain("eq(schema.workspaces.status, 'creating')");
    expect(replayQuery).toContain('isNull(schema.workspaces.dispatchedAt)');
  });

  it('ready handler still dispatches legacy creating workspaces without dispatched_at', () => {
    const replayLoop = sectionAfter(nodeLifecycleSource, 'for (const workspace of pendingWorkspaces)');

    expect(replayLoop).toContain('await createWorkspaceOnNode(nodeId, c.env, workspace.userId');
    expect(replayLoop).toContain('workspaceId: workspace.id');
    expect(replayLoop).toContain('repository: workspace.repository');
    expect(replayLoop).toContain('branch: workspace.branch');
  });

  it('ready handler marks legacy workspaces as dispatched after successful replay dispatch', () => {
    const replayLoop = sectionAfter(nodeLifecycleSource, 'for (const workspace of pendingWorkspaces)');
    const dispatchIndex = replayLoop.indexOf('await createWorkspaceOnNode(nodeId, c.env, workspace.userId');
    const markerIndex = replayLoop.indexOf('dispatchedAt: new Date().toISOString()');

    expect(dispatchIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeGreaterThan(dispatchIndex);
  });

  it('task runner routes workspace creation through a durable dispatch step', () => {
    const creationSection = sectionBetween(
      taskRunnerWorkspaceSource,
      'export async function handleWorkspaceCreation',
      'async function recoverWorkspaceFromD1',
    );

    expect(creationSection).toContain("advanceToStep(state, 'workspace_dispatch')");
    expect(creationSection).not.toContain("advanceToStep(state, 'workspace_ready')");
  });

  it('task runner sets dispatched_at after successful VM agent dispatch acknowledgement', () => {
    const dispatchSection = sectionAfter(taskRunnerWorkspaceSource, 'export async function handleWorkspaceDispatch');
    const dispatchIndex = dispatchSection.indexOf('await createWorkspaceOnVmAgent(state, rc, workspaceId, nodeId)');
    const markerIndex = dispatchSection.indexOf('UPDATE workspaces SET dispatched_at = ?, updated_at = ? WHERE id = ?');

    expect(dispatchIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeGreaterThan(dispatchIndex);
  });

  it('workspace_ready sends undispatched recovered workspaces back to workspace_dispatch', () => {
    const readySection = sectionAfter(taskRunnerWorkspaceSource, 'export async function handleWorkspaceReady');

    expect(readySection).toContain('workspace_ready_without_dispatch_ack');
    expect(readySection).toContain("advanceToStep(state, 'workspace_dispatch')");
  });

  it('UI workspace creation path sets dispatched_at after successful VM agent workspace creation', () => {
    const scheduleSection = sectionAfter(workspaceHelpersSource, 'export async function scheduleWorkspaceCreateOnNode');
    const dispatchIndex = scheduleSection.indexOf('await createWorkspaceOnNode(nodeId, env, userId');
    const markerIndex = scheduleSection.indexOf('UPDATE workspaces SET dispatched_at = ? WHERE id = ?');

    expect(dispatchIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeGreaterThan(dispatchIndex);
  });
});
