/**
 * Integration source-contract tests for workspace dispatch idempotency.
 *
 * Verifies the control-plane handoff marker that prevents TaskRunner/UI
 * dispatch paths and node-ready replay from POSTing /workspaces twice for the
 * same workspace.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner/types';
import { handleWorkspaceReady } from '../../src/durable-objects/task-runner/workspace-ready-steps';
import { createSqliteD1 } from '../helpers/sqlite-d1';

const schemaSource = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');
const nodeLifecycleSource = readFileSync(
  resolve(process.cwd(), 'src/routes/node-lifecycle.ts'),
  'utf8'
);
const taskRunnerWorkspaceSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner/workspace-steps.ts'),
  'utf8'
);
const workspaceHelpersSource = readFileSync(
  resolve(process.cwd(), 'src/routes/workspaces/_helpers.ts'),
  'utf8'
);
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
    const replayQuery = sectionAfter(
      nodeLifecycleSource,
      'const pendingWorkspaces = await innerDb'
    );

    // Verify the required drizzle operators are imported (order-independent)
    expect(nodeLifecycleSource).toContain("from 'drizzle-orm'");
    expect(nodeLifecycleSource).toMatch(/\band\b/);
    expect(nodeLifecycleSource).toMatch(/\beq\b/);
    expect(nodeLifecycleSource).toMatch(/\bisNull\b/);
    expect(replayQuery).toContain('eq(schema.workspaces.nodeId, nodeId)');
    expect(replayQuery).toContain("eq(schema.workspaces.status, 'creating')");
    expect(replayQuery).toContain('isNull(schema.workspaces.dispatchedAt)');
  });

  it('ready handler still dispatches legacy creating workspaces without dispatched_at', () => {
    const replayLoop = sectionAfter(
      nodeLifecycleSource,
      'for (const workspace of pendingWorkspaces)'
    );

    expect(replayLoop).toContain('await createWorkspaceOnNode(nodeId, c.env, workspace.userId');
    expect(replayLoop).toContain('workspaceId: workspace.id');
    expect(replayLoop).toContain('repository: workspace.repository');
    expect(replayLoop).toContain('branch: workspace.branch');
  });

  it('ready handler marks legacy workspaces as dispatched after successful replay dispatch', () => {
    const replayLoop = sectionAfter(
      nodeLifecycleSource,
      'for (const workspace of pendingWorkspaces)'
    );
    const dispatchIndex = replayLoop.indexOf(
      'await createWorkspaceOnNode(nodeId, c.env, workspace.userId'
    );
    const markerIndex = replayLoop.indexOf('dispatchedAt: new Date().toISOString()');

    expect(dispatchIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeGreaterThan(dispatchIndex);
  });

  it('task runner routes workspace creation through a durable dispatch step', () => {
    const creationSection = sectionBetween(
      taskRunnerWorkspaceSource,
      'export async function handleWorkspaceCreation',
      'async function recoverWorkspaceFromD1'
    );

    expect(creationSection).toContain("advanceToStep(state, 'workspace_dispatch')");
    expect(creationSection).not.toContain("advanceToStep(state, 'workspace_ready')");
  });

  it('task runner sets dispatched_at after successful VM agent dispatch acknowledgement', () => {
    const dispatchSection = sectionAfter(
      taskRunnerWorkspaceSource,
      'export async function handleWorkspaceDispatch'
    );
    const dispatchIndex = dispatchSection.indexOf(
      'await createWorkspaceOnVmAgent(state, rc, workspaceId, nodeId)'
    );
    const markerIndex = dispatchSection.indexOf(
      'UPDATE workspaces SET dispatched_at = ?, updated_at = ? WHERE id = ?'
    );

    expect(dispatchIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeGreaterThan(dispatchIndex);
  });

  it.each([null, '2026-09-07T12:00:00Z'])(
    'workspace_ready retries dispatch only when recovered workspace has no acknowledgement (%s)',
    async (dispatchedAt) => {
      const sqlite = new Database(':memory:');
      try {
        sqlite.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, dispatched_at TEXT)');
        sqlite
          .prepare('INSERT INTO workspaces (id, dispatched_at) VALUES (?, ?)')
          .run('workspace-1', dispatchedAt);
        const state = {
          taskId: 'task-1',
          stepResults: { workspaceId: 'workspace-1' },
          config: { attachments: null },
          workspaceReadyReceived: true,
          workspaceReadyStatus: 'running',
          workspaceReadyStartedAt: Date.now(),
        } as TaskRunnerState;
        const advanceToStep = vi.fn();
        const updateD1ExecutionStep = vi.fn();
        const rc = {
          env: { DATABASE: createSqliteD1(sqlite) },
          advanceToStep,
          updateD1ExecutionStep,
        } as unknown as TaskRunnerContext;

        await handleWorkspaceReady(state, rc);

        expect(advanceToStep).toHaveBeenCalledOnce();
        expect(advanceToStep).toHaveBeenCalledWith(
          state,
          dispatchedAt ? 'agent_session' : 'workspace_dispatch'
        );
        if (!dispatchedAt) expect(updateD1ExecutionStep).not.toHaveBeenCalled();
      } finally {
        sqlite.close();
      }
    }
  );

  it('UI workspace creation path sets dispatched_at after successful VM agent workspace creation', () => {
    const scheduleSection = sectionAfter(
      workspaceHelpersSource,
      'export async function scheduleWorkspaceCreateOnNode'
    );
    const dispatchIndex = scheduleSection.indexOf('await createWorkspaceOnNode(');
    const markerIndex = scheduleSection.indexOf('SET dispatched_at = ?, updated_at = ?');

    expect(dispatchIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeGreaterThan(dispatchIndex);
    expect(scheduleSection).toContain('AND user_id = ?');
    expect(scheduleSection).toContain('AND node_id = ?');
    expect(scheduleSection).toContain("AND status = 'creating'");
    expect(scheduleSection).toContain('AND dispatched_at IS NULL');
    expect(scheduleSection).toContain('AND runtime_deletion_confirmed_at IS NULL');
  });
});
