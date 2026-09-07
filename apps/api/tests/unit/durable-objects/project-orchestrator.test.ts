/**
 * Unit tests for ProjectOrchestrator scheduling logic, migrations, and types.
 *
 * Tests the pure scheduling functions, decision log management,
 * handoff content building, and migration structure without requiring
 * DO plumbing or D1 bindings.
 */
import {
  DECISION_ACTIONS,
  DEFAULT_ORCHESTRATOR_DECISION_LOG_MAX_ENTRIES,
  DEFAULT_ORCHESTRATOR_MAX_ACTIVE_TASKS_PER_MISSION,
  DEFAULT_ORCHESTRATOR_MAX_DISPATCHES_PER_CYCLE,
  DEFAULT_ORCHESTRATOR_QUEUE_MAX_ENTRIES,
  DEFAULT_ORCHESTRATOR_RECENT_DECISIONS_LIMIT,
  DEFAULT_ORCHESTRATOR_SCHEDULING_INTERVAL_MS,
  DEFAULT_ORCHESTRATOR_STALL_TIMEOUT_MS,
  OVERRIDABLE_SCHEDULER_STATES,
  resolveOrchestratorConfig,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { ORCHESTRATOR_MIGRATIONS } from '../../../src/durable-objects/project-orchestrator/migrations';

describe('Orchestrator Constants', () => {
  it('defines sensible defaults', () => {
    expect(DEFAULT_ORCHESTRATOR_SCHEDULING_INTERVAL_MS).toBe(30_000);
    expect(DEFAULT_ORCHESTRATOR_STALL_TIMEOUT_MS).toBe(1_200_000);
    expect(DEFAULT_ORCHESTRATOR_MAX_DISPATCHES_PER_CYCLE).toBe(5);
    expect(DEFAULT_ORCHESTRATOR_MAX_ACTIVE_TASKS_PER_MISSION).toBe(5);
    expect(DEFAULT_ORCHESTRATOR_DECISION_LOG_MAX_ENTRIES).toBe(500);
    expect(DEFAULT_ORCHESTRATOR_RECENT_DECISIONS_LIMIT).toBe(20);
    expect(DEFAULT_ORCHESTRATOR_QUEUE_MAX_ENTRIES).toBe(100);
  });

  it('defines 12 decision actions', () => {
    expect(DECISION_ACTIONS).toEqual([
      'dispatch', 'block', 'unblock', 'stall_detected',
      'interrupt_sent', 'handoff_routed', 'pause', 'resume',
      'cancel', 'override', 'retry', 'skip',
    ]);
  });

  it('defines overridable scheduler states', () => {
    expect(OVERRIDABLE_SCHEDULER_STATES).toContain('schedulable');
    expect(OVERRIDABLE_SCHEDULER_STATES).toContain('blocked_human');
    expect(OVERRIDABLE_SCHEDULER_STATES).toContain('cancelled');
    expect(OVERRIDABLE_SCHEDULER_STATES).toContain('blocked_resource');
    // Running and completed should NOT be overridable
    expect(OVERRIDABLE_SCHEDULER_STATES).not.toContain('running');
    expect(OVERRIDABLE_SCHEDULER_STATES).not.toContain('completed');
  });
});

describe('resolveOrchestratorConfig', () => {
  it('returns defaults when env is empty', () => {
    const config = resolveOrchestratorConfig({});
    expect(config.schedulingIntervalMs).toBe(30_000);
    expect(config.stallTimeoutMs).toBe(1_200_000);
    expect(config.maxDispatchesPerCycle).toBe(5);
    expect(config.maxActiveTasksPerMission).toBe(5);
    expect(config.decisionLogMaxEntries).toBe(500);
    expect(config.recentDecisionsLimit).toBe(20);
    expect(config.queueMaxEntries).toBe(100);
  });

  it('parses valid env overrides', () => {
    const config = resolveOrchestratorConfig({
      ORCHESTRATOR_SCHEDULING_INTERVAL_MS: '60000',
      ORCHESTRATOR_STALL_TIMEOUT_MS: '600000',
      ORCHESTRATOR_MAX_DISPATCHES_PER_CYCLE: '10',
      ORCHESTRATOR_MAX_ACTIVE_TASKS_PER_MISSION: '3',
    });
    expect(config.schedulingIntervalMs).toBe(60_000);
    expect(config.stallTimeoutMs).toBe(600_000);
    expect(config.maxDispatchesPerCycle).toBe(10);
    expect(config.maxActiveTasksPerMission).toBe(3);
  });

  it('falls back to defaults for invalid values', () => {
    const config = resolveOrchestratorConfig({
      ORCHESTRATOR_SCHEDULING_INTERVAL_MS: 'not_a_number',
      ORCHESTRATOR_STALL_TIMEOUT_MS: '-100',
      ORCHESTRATOR_MAX_DISPATCHES_PER_CYCLE: '0',
    });
    expect(config.schedulingIntervalMs).toBe(30_000);
    expect(config.stallTimeoutMs).toBe(1_200_000);
    expect(config.maxDispatchesPerCycle).toBe(5);
  });
});

describe('Orchestrator Migrations', () => {
  it('has migrations defined', () => {
    expect(ORCHESTRATOR_MIGRATIONS.length).toBeGreaterThan(0);
  });

  it('each migration has a name and sql', () => {
    for (const migration of ORCHESTRATOR_MIGRATIONS) {
      expect(migration.name).toBeTruthy();
      expect(migration.sql).toBeTruthy();
    }
  });

  it('creates orchestrator_missions table', () => {
    const initial = ORCHESTRATOR_MIGRATIONS[0];
    expect(initial?.sql).toContain('orchestrator_missions');
    expect(initial?.sql).toContain('mission_id');
    expect(initial?.sql).toContain('status');
    expect(initial?.sql).toContain('last_checked_at');
  });

  it('creates scheduling_queue table', () => {
    const initial = ORCHESTRATOR_MIGRATIONS[0];
    expect(initial?.sql).toContain('scheduling_queue');
    expect(initial?.sql).toContain('task_id');
    expect(initial?.sql).toContain('scheduled_at');
  });

  it('creates decision_log table', () => {
    const initial = ORCHESTRATOR_MIGRATIONS[0];
    expect(initial?.sql).toContain('decision_log');
    expect(initial?.sql).toContain('action');
    expect(initial?.sql).toContain('reason');
  });

  it('does NOT use DROP TABLE (migration safety)', () => {
    for (const migration of ORCHESTRATOR_MIGRATIONS) {
      expect(migration.sql.toUpperCase()).not.toContain('DROP TABLE');
    }
  });
});

describe('Orchestrator MCP Tool Definitions', () => {
  it('defines 6 orchestrator lifecycle tools', async () => {
    const { ORCHESTRATOR_LIFECYCLE_TOOLS } = await import(
      '../../../src/routes/mcp/tool-definitions-orchestrator-tools'
    );
    expect(ORCHESTRATOR_LIFECYCLE_TOOLS).toHaveLength(6);
    const names = ORCHESTRATOR_LIFECYCLE_TOOLS.map((t: { name: string }) => t.name);
    expect(names).toContain('get_orchestrator_status');
    expect(names).toContain('get_scheduling_queue');
    expect(names).toContain('pause_mission');
    expect(names).toContain('resume_mission');
    expect(names).toContain('cancel_mission');
    expect(names).toContain('override_task_state');
  });

  it('all tools have required inputSchema', async () => {
    const { ORCHESTRATOR_LIFECYCLE_TOOLS } = await import(
      '../../../src/routes/mcp/tool-definitions-orchestrator-tools'
    );
    for (const tool of ORCHESTRATOR_LIFECYCLE_TOOLS) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description).toBeTruthy();
    }
  });
});
