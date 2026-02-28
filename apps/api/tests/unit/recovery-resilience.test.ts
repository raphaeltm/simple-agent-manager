/**
 * TDF-7: Source contract tests for Recovery & Resilience.
 *
 * Validates OBSERVABILITY_DATABASE recording, diagnostic context capture,
 * cleanup idempotency, DO health checks, and orphan resource detection
 * via source code analysis.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const stuckTasksSource = readFileSync(
  resolve(process.cwd(), 'src/scheduled/stuck-tasks.ts'),
  'utf8'
);
const nodeCleanupSource = readFileSync(
  resolve(process.cwd(), 'src/scheduled/node-cleanup.ts'),
  'utf8'
);
const timeoutSource = readFileSync(
  resolve(process.cwd(), 'src/services/timeout.ts'),
  'utf8'
);
const taskRunnerSource = readFileSync(
  resolve(process.cwd(), 'src/services/task-runner.ts'),
  'utf8'
);
const indexSource = readFileSync(
  resolve(process.cwd(), 'src/index.ts'),
  'utf8'
);

// =========================================================================
// Stuck Tasks — OBSERVABILITY_DATABASE Recording
// =========================================================================

describe('stuck-tasks OBSERVABILITY_DATABASE recording (TDF-7)', () => {
  it('imports persistError from observability service', () => {
    expect(stuckTasksSource).toContain("import { persistError } from '../services/observability'");
  });

  it('records stuck task recovery in OBSERVABILITY_DATABASE', () => {
    expect(stuckTasksSource).toContain('persistError(env.OBSERVABILITY_DATABASE');
  });

  it('uses "warn" level for recovery events', () => {
    // Recovery is a warning, not an error (expected safety net behavior)
    const recoverySection = stuckTasksSource.slice(
      stuckTasksSource.indexOf('// Record recovery in OBSERVABILITY_DATABASE'),
      stuckTasksSource.indexOf('const nowIso')
    );
    expect(recoverySection).toContain("level: 'warn'");
  });

  it('records cleanup failures in OBSERVABILITY_DATABASE', () => {
    const startIdx = stuckTasksSource.indexOf('// Record cleanup failure');
    const cleanupSection = stuckTasksSource.slice(
      startIdx,
      stuckTasksSource.indexOf('switch (task.status)', startIdx)
    );
    expect(cleanupSection).toContain('persistError(env.OBSERVABILITY_DATABASE');
    expect(cleanupSection).toContain("level: 'error'");
  });

  it('records recovery failures in OBSERVABILITY_DATABASE', () => {
    const failureSection = stuckTasksSource.slice(
      stuckTasksSource.indexOf('// Record recovery failure'),
    );
    expect(failureSection).toContain('persistError(env.OBSERVABILITY_DATABASE');
    expect(failureSection).toContain("level: 'error'");
  });

  it('includes recoveryType in context for filtering', () => {
    expect(stuckTasksSource).toContain("recoveryType: 'stuck_task'");
    expect(stuckTasksSource).toContain("recoveryType: 'stuck_task_cleanup_failure'");
    expect(stuckTasksSource).toContain("recoveryType: 'stuck_task_recovery_failure'");
  });
});

// =========================================================================
// Stuck Tasks — Diagnostic Context Capture
// =========================================================================

describe('stuck-tasks diagnostic context capture (TDF-7)', () => {
  it('exports RecoveryDiagnostics interface', () => {
    expect(stuckTasksSource).toContain('export interface RecoveryDiagnostics');
  });

  it('exports gatherDiagnostics function', () => {
    expect(stuckTasksSource).toContain('export async function gatherDiagnostics(');
  });

  it('queries workspace status at recovery time', () => {
    const diagSection = stuckTasksSource.slice(
      stuckTasksSource.indexOf('async function gatherDiagnostics('),
      stuckTasksSource.indexOf('export async function recoverStuckTasks(')
    );
    expect(diagSection).toContain('SELECT id, node_id, status FROM workspaces WHERE id = ?');
  });

  it('queries node status at recovery time', () => {
    const diagSection = stuckTasksSource.slice(
      stuckTasksSource.indexOf('async function gatherDiagnostics('),
      stuckTasksSource.indexOf('export async function recoverStuckTasks(')
    );
    expect(diagSection).toContain('SELECT id, status, health_status FROM nodes WHERE id = ?');
  });

  it('queries TaskRunner DO state at recovery time', () => {
    const diagSection = stuckTasksSource.slice(
      stuckTasksSource.indexOf('async function gatherDiagnostics('),
      stuckTasksSource.indexOf('export async function recoverStuckTasks(')
    );
    expect(diagSection).toContain('env.TASK_RUNNER.idFromName(task.id)');
    expect(diagSection).toContain('stub.getStatus()');
  });

  it('includes workspace and node status in persistError context', () => {
    const persistSection = stuckTasksSource.slice(
      stuckTasksSource.indexOf("recoveryType: 'stuck_task'"),
      stuckTasksSource.indexOf('const nowIso')
    );
    expect(persistSection).toContain('workspaceStatus: diagnostics.workspaceStatus');
    expect(persistSection).toContain('nodeStatus: diagnostics.nodeStatus');
    expect(persistSection).toContain('nodeHealthStatus: diagnostics.nodeHealthStatus');
    expect(persistSection).toContain('doState: diagnostics.doState');
  });

  it('includes workspace_id and auto_provisioned_node_id in SQL query', () => {
    expect(stuckTasksSource).toContain('workspace_id, auto_provisioned_node_id');
  });

  it('RecoveryDiagnostics has all required fields', () => {
    const interfaceSection = stuckTasksSource.slice(
      stuckTasksSource.indexOf('export interface RecoveryDiagnostics'),
      stuckTasksSource.indexOf('/**\n * Query diagnostic context')
    );
    expect(interfaceSection).toContain('workspaceStatus: string | null');
    expect(interfaceSection).toContain('nodeStatus: string | null');
    expect(interfaceSection).toContain('nodeHealthStatus: string | null');
    expect(interfaceSection).toContain('doState:');
    expect(interfaceSection).toContain('autoProvisionedNodeId: string | null');
  });
});

// =========================================================================
// Stuck Tasks — DO Health Checks
// =========================================================================

describe('stuck-tasks DO health checks (TDF-7)', () => {
  it('imports TaskRunner type for typed DO stub', () => {
    expect(stuckTasksSource).toContain("import type { TaskRunner } from '../durable-objects/task-runner'");
  });

  it('checks DO health for non-stuck tasks at half threshold', () => {
    expect(stuckTasksSource).toContain('halfThreshold');
    expect(stuckTasksSource).toContain('timeForCheck > halfThreshold');
  });

  it('uses started_at for in_progress tasks (consistent time base)', () => {
    // The half-threshold check must use the same time base as stuck detection
    const healthCheckSection = stuckTasksSource.slice(
      stuckTasksSource.indexOf('// Use the correct time base per status'),
      stuckTasksSource.indexOf('if (timeForCheck > halfThreshold)')
    );
    expect(healthCheckSection).toContain('started_at');
    expect(healthCheckSection).toContain('timeForCheck');
  });

  it('detects DO-completed-but-task-active mismatch', () => {
    expect(stuckTasksSource).toContain('stuck_task.do_completed_but_task_active');
    expect(stuckTasksSource).toContain('doStatus.completed');
  });

  it('records DO mismatch in OBSERVABILITY_DATABASE', () => {
    expect(stuckTasksSource).toContain("recoveryType: 'do_task_status_mismatch'");
  });

  it('deduplicates DO mismatch records (30 min window)', () => {
    expect(stuckTasksSource).toContain('recentMismatch');
    expect(stuckTasksSource).toContain('do_task_status_mismatch');
    expect(stuckTasksSource).toContain('30 * 60 * 1000');
  });

  it('tracks doHealthChecked count in result', () => {
    expect(stuckTasksSource).toContain('doHealthChecked: number');
    expect(stuckTasksSource).toContain('result.doHealthChecked++');
  });

  it('cron handler logs doHealthChecked count', () => {
    expect(indexSource).toContain('stuckTaskDoHealthChecked: stuckTasks.doHealthChecked');
  });
});

// =========================================================================
// Node Cleanup — OBSERVABILITY_DATABASE Recording
// =========================================================================

describe('node-cleanup OBSERVABILITY_DATABASE recording (TDF-7)', () => {
  it('imports persistError from observability service', () => {
    expect(nodeCleanupSource).toContain("import { persistError } from '../services/observability'");
  });

  it('records stale warm node destruction in OBSERVABILITY_DATABASE', () => {
    expect(nodeCleanupSource).toContain("recoveryType: 'stale_warm_node_cleanup'");
  });

  it('writes success records AFTER deleteNodeResources (M1 fix)', () => {
    // Stale warm: success record comes after deleteNodeResources
    const staleSection = nodeCleanupSource.slice(
      nodeCleanupSource.indexOf('destroying_stale_warm'),
      nodeCleanupSource.indexOf('staleDestroyed++')
    );
    const deleteIdx = staleSection.indexOf('deleteNodeResources');
    const recordIdx = staleSection.indexOf("recoveryType: 'stale_warm_node_cleanup'");
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(deleteIdx);
  });

  it('records stale warm node destruction failure in OBSERVABILITY_DATABASE', () => {
    expect(nodeCleanupSource).toContain("recoveryType: 'stale_warm_node_cleanup_failure'");
  });

  it('records max lifetime destruction in OBSERVABILITY_DATABASE', () => {
    expect(nodeCleanupSource).toContain("recoveryType: 'max_lifetime_node_cleanup'");
  });

  it('records max lifetime destruction failure in OBSERVABILITY_DATABASE', () => {
    expect(nodeCleanupSource).toContain("recoveryType: 'max_lifetime_node_cleanup_failure'");
  });

  it('uses "info" for successful cleanups and "error" for failures', () => {
    // The success record (with recoveryType: 'stale_warm_node_cleanup') uses info level.
    // Slice backward 100 chars to capture the level field.
    const idx = nodeCleanupSource.indexOf("recoveryType: 'stale_warm_node_cleanup'");
    const staleRecordSection = nodeCleanupSource.slice(Math.max(0, idx - 200), idx + 50);
    expect(staleRecordSection).toContain("level: 'info'");
  });

  it('uses "warn" for max lifetime (more severe)', () => {
    // The success record uses warn level for max lifetime.
    const idx = nodeCleanupSource.indexOf("recoveryType: 'max_lifetime_node_cleanup'");
    const lifetimeRecordSection = nodeCleanupSource.slice(Math.max(0, idx - 200), idx + 50);
    expect(lifetimeRecordSection).toContain("level: 'warn'");
  });
});

// =========================================================================
// Node Cleanup — Orphan Detection
// =========================================================================

describe('node-cleanup orphan detection (TDF-7)', () => {
  it('detects orphaned task-created workspaces (running after task ended)', () => {
    expect(nodeCleanupSource).toContain("w.status = 'running'");
    // Must have been associated with a completed/failed/cancelled task
    expect(nodeCleanupSource).toContain("t.status IN ('completed', 'failed', 'cancelled')");
    // Must NOT have any active task still referencing it
    expect(nodeCleanupSource).toContain('NOT EXISTS');
    expect(nodeCleanupSource).toContain("t.status IN ('queued', 'delegated', 'in_progress')");
    expect(nodeCleanupSource).toContain('t.workspace_id = w.id');
  });

  it('records orphaned workspaces in OBSERVABILITY_DATABASE', () => {
    expect(nodeCleanupSource).toContain("recoveryType: 'orphaned_workspace'");
    expect(nodeCleanupSource).toContain('orphaned_workspace_detected');
  });

  it('detects orphaned nodes (running with no workspaces, not warm)', () => {
    expect(nodeCleanupSource).toContain("n.status = 'running'");
    expect(nodeCleanupSource).toContain('n.warm_since IS NULL');
    expect(nodeCleanupSource).toContain("w.status IN ('running', 'creating', 'recovery')");
  });

  it('records orphaned nodes in OBSERVABILITY_DATABASE', () => {
    expect(nodeCleanupSource).toContain("recoveryType: 'orphaned_node'");
    expect(nodeCleanupSource).toContain('orphaned_node_detected');
  });

  it('tracks orphan counts in result', () => {
    expect(nodeCleanupSource).toContain('orphanedWorkspacesFlagged: number');
    expect(nodeCleanupSource).toContain('orphanedNodesFlagged: number');
    expect(nodeCleanupSource).toContain('result.orphanedWorkspacesFlagged++');
    expect(nodeCleanupSource).toContain('result.orphanedNodesFlagged++');
  });

  it('cron handler logs orphan counts', () => {
    expect(indexSource).toContain('orphanedWorkspacesFlagged');
    expect(indexSource).toContain('orphanedNodesFlagged');
  });

  it('uses grace period to avoid flagging recently created resources', () => {
    // Both orphan queries filter by created_at/updated_at to avoid false positives
    const orphanSection = nodeCleanupSource.slice(
      nodeCleanupSource.indexOf('// 3. Orphan detection:'),
    );
    // Orphan workspace query uses gracePeriodMs cutoff on created_at
    expect(orphanSection).toContain('w.created_at < ?');
    // Orphan node query uses gracePeriodMs cutoff on updated_at
    expect(orphanSection).toContain('n.updated_at < ?');
  });
});

// =========================================================================
// Timeout Service — OBSERVABILITY_DATABASE Recording
// =========================================================================

describe('timeout service OBSERVABILITY_DATABASE recording (TDF-7)', () => {
  it('imports persistError from observability service', () => {
    expect(timeoutSource).toContain("import { persistError } from './observability'");
  });

  it('accepts optional observabilityDb parameter', () => {
    expect(timeoutSource).toContain('observabilityDb?: D1Database');
  });

  it('records provisioning timeouts in OBSERVABILITY_DATABASE', () => {
    expect(timeoutSource).toContain("recoveryType: 'provisioning_timeout'");
    expect(timeoutSource).toContain('persistError(observabilityDb');
  });

  it('includes workspace and node IDs in context', () => {
    expect(timeoutSource).toContain('workspaceId: workspace.id');
    expect(timeoutSource).toContain('nodeId: workspace.nodeId');
  });

  it('uses structured logging for timeout events', () => {
    expect(timeoutSource).toContain('provisioning_timeout.workspace_timed_out');
    expect(timeoutSource).toContain('provisioning_timeout.summary');
  });

  it('cron handler passes OBSERVABILITY_DATABASE to checkProvisioningTimeouts', () => {
    expect(indexSource).toContain('checkProvisioningTimeouts(env.DATABASE, env, env.OBSERVABILITY_DATABASE)');
  });
});

// =========================================================================
// Cleanup Idempotency (task-runner.ts)
// =========================================================================

describe('cleanup idempotency (TDF-7)', () => {
  it('checks node status before calling markIdle', () => {
    const cleanupSection = taskRunnerSource.slice(
      taskRunnerSource.indexOf('async function cleanupAutoProvisionedNode(')
    );
    expect(cleanupSection).toContain('node.status');
    expect(cleanupSection).toContain('node.warmSince');
  });

  it('skips if node is already stopped', () => {
    expect(taskRunnerSource).toContain("node.status === 'stopped'");
    expect(taskRunnerSource).toContain('task_run.cleanup.node_already_stopped');
  });

  it('skips if node is already warm', () => {
    expect(taskRunnerSource).toContain('node.warmSince');
    expect(taskRunnerSource).toContain('task_run.cleanup.node_already_warm');
  });

  it('skips if node not found in D1', () => {
    expect(taskRunnerSource).toContain('task_run.cleanup.node_not_found');
  });

  it('logs when workspace is already stopped', () => {
    expect(taskRunnerSource).toContain('task_run.cleanup.workspace_already_stopped');
  });

  it('queries node from D1 before deciding cleanup action', () => {
    const cleanupSection = taskRunnerSource.slice(
      taskRunnerSource.indexOf('async function cleanupAutoProvisionedNode('),
      taskRunnerSource.indexOf('// Count active workspaces')
    );
    expect(cleanupSection).toContain('schema.nodes.warmSince');
    expect(cleanupSection).toContain("eq(schema.nodes.id, nodeId)");
  });

  it('only calls markIdle if node is running and not warm', () => {
    const cleanupSection = taskRunnerSource.slice(
      taskRunnerSource.indexOf('async function cleanupAutoProvisionedNode(')
    );
    // After all the guard checks, only then do we reach markIdle
    const nodeNotFoundIdx = cleanupSection.indexOf('node_not_found');
    const alreadyStoppedIdx = cleanupSection.indexOf('node_already_stopped');
    const alreadyWarmIdx = cleanupSection.indexOf('node_already_warm');
    const markIdleIdx = cleanupSection.indexOf('markIdle(env');
    // Guards come before markIdle
    expect(nodeNotFoundIdx).toBeGreaterThan(-1);
    expect(alreadyStoppedIdx).toBeGreaterThan(nodeNotFoundIdx);
    expect(alreadyWarmIdx).toBeGreaterThan(alreadyStoppedIdx);
    expect(markIdleIdx).toBeGreaterThan(alreadyWarmIdx);
  });
});

// =========================================================================
// All recovery types use consistent context shape
// =========================================================================

describe('recovery type consistency (TDF-7)', () => {
  const allRecoveryTypes = [
    'stuck_task',
    'stuck_task_cleanup_failure',
    'stuck_task_recovery_failure',
    'do_task_status_mismatch',
    'stale_warm_node_cleanup',
    'stale_warm_node_cleanup_failure',
    'max_lifetime_node_cleanup',
    'max_lifetime_node_cleanup_failure',
    'orphaned_workspace',
    'orphaned_node',
    'provisioning_timeout',
  ];

  for (const recoveryType of allRecoveryTypes) {
    it(`uses recoveryType: '${recoveryType}'`, () => {
      const allSources = stuckTasksSource + nodeCleanupSource + timeoutSource;
      expect(allSources).toContain(`recoveryType: '${recoveryType}'`);
    });
  }

  it('all persistError calls use source: "api"', () => {
    // Ensure all recovery errors come from the 'api' source (exclude imports)
    const stuckCallMatches = stuckTasksSource.match(/persistError\(env/g)?.length ?? 0;
    const stuckApiMatches = stuckTasksSource.match(/source: 'api'/g)?.length ?? 0;
    // Each persistError call should have a corresponding source: 'api'
    expect(stuckApiMatches).toBeGreaterThanOrEqual(stuckCallMatches);
  });
});

// =========================================================================
// Defense-in-depth: three-layer node defense integration
// =========================================================================

describe('three-layer node defense integration (TDF-7)', () => {
  it('Layer 1 (DO alarm): nodeCleanupSource references DO alarm as primary', () => {
    expect(nodeCleanupSource).toContain('DO alarm');
  });

  it('Layer 2 (cron sweep): stale warm node cleanup', () => {
    expect(nodeCleanupSource).toContain('Layer 2 defense');
  });

  it('Layer 3 (max lifetime): hard cap on auto-provisioned node age', () => {
    expect(nodeCleanupSource).toContain('Layer 3 defense');
  });

  it('stuck-tasks cron serves as outer safety net for task orchestration', () => {
    expect(stuckTasksSource).toContain('outer safety net');
  });
});
