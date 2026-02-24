/**
 * Integration test: warm node pooling lifecycle (T048).
 *
 * Verifies the full wiring:
 * 1. Task completes → workspace destroyed → node marked warm via NodeLifecycle DO
 * 2. New task claims warm node → fast startup (no provisioning)
 * 3. Warm node timeout → alarm fires → node destroyed (via cron sweep)
 *
 * Source contract test — verifies correct wiring across modules.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('warm node pooling lifecycle integration', () => {
  const taskRunnerFile = readFileSync(resolve(process.cwd(), 'src/services/task-runner.ts'), 'utf8');
  const selectorFile = readFileSync(resolve(process.cwd(), 'src/services/node-selector.ts'), 'utf8');
  const doFile = readFileSync(resolve(process.cwd(), 'src/durable-objects/node-lifecycle.ts'), 'utf8');
  const cleanupFile = readFileSync(resolve(process.cwd(), 'src/scheduled/node-cleanup.ts'), 'utf8');
  const serviceFile = readFileSync(resolve(process.cwd(), 'src/services/node-lifecycle.ts'), 'utf8');
  const constantsFile = readFileSync(resolve(process.cwd(), '../../packages/shared/src/constants.ts'), 'utf8');

  describe('flow: task complete → workspace destroyed → node warm', () => {
    it('cleanupTaskRun calls cleanupAutoProvisionedNode', () => {
      expect(taskRunnerFile).toContain('cleanupAutoProvisionedNode');
    });

    it('cleanupAutoProvisionedNode calls nodeLifecycleService.markIdle', () => {
      const section = taskRunnerFile.slice(
        taskRunnerFile.indexOf('function cleanupAutoProvisionedNode')
      );
      expect(section).toContain('nodeLifecycleService.markIdle');
    });

    it('service.markIdle calls DO.markIdle via stub', () => {
      expect(serviceFile).toContain('stub.markIdle(nodeId, userId)');
    });

    it('DO.markIdle sets warm status and schedules alarm', () => {
      expect(doFile).toContain("status: 'warm'");
      expect(doFile).toContain('setAlarm(now + warmTimeout)');
    });

    it('DO.markIdle updates D1 warm_since', () => {
      expect(doFile).toContain('updateD1WarmSince');
    });
  });

  describe('flow: new task → claim warm node → fast startup', () => {
    it('selectNodeForTaskRun queries warm nodes in D1', () => {
      expect(selectorFile).toContain('isNotNull(schema.nodes.warmSince)');
    });

    it('selectNodeForTaskRun calls nodeLifecycle.tryClaim', () => {
      expect(selectorFile).toContain('nodeLifecycle.tryClaim');
    });

    it('service.tryClaim calls DO.tryClaim via stub', () => {
      expect(serviceFile).toContain('stub.tryClaim(taskId)');
    });

    it('DO.tryClaim transitions warm → active and cancels alarm', () => {
      const tryClaimSection = doFile.slice(doFile.indexOf('async tryClaim'));
      expect(tryClaimSection).toContain("state.status = 'active'");
      expect(tryClaimSection).toContain('state.claimedByTask = taskId');
      expect(tryClaimSection).toContain('deleteAlarm()');
    });
  });

  describe('flow: warm timeout → alarm fires → node destroyed', () => {
    it('DO alarm transitions warm → destroying', () => {
      expect(doFile).toContain("state.status = 'destroying'");
    });

    it('DO alarm marks D1 node status as stopped', () => {
      expect(doFile).toContain("SET status = 'stopped', warm_since = NULL");
    });

    it('cron sweep finds stale warm nodes and calls deleteNodeResources', () => {
      expect(cleanupFile).toContain('deleteNodeResources(node.id, node.userId, env)');
    });

    it('cron sweep also enforces max auto-provisioned node lifetime', () => {
      expect(cleanupFile).toContain('MAX_AUTO_NODE_LIFETIME_MS');
    });
  });

  describe('three-layer defense: DO alarm + cron sweep + max lifetime', () => {
    it('layer 1: DO alarm — configurable warm timeout', () => {
      expect(doFile).toContain('NODE_WARM_TIMEOUT_MS');
      expect(constantsFile).toContain('DEFAULT_NODE_WARM_TIMEOUT_MS');
    });

    it('layer 2: cron sweep — catches stale warm nodes', () => {
      expect(cleanupFile).toContain('NODE_WARM_GRACE_PERIOD_MS');
      expect(constantsFile).toContain('DEFAULT_NODE_WARM_GRACE_PERIOD_MS');
    });

    it('layer 3: max lifetime — hard cap on auto-provisioned nodes', () => {
      expect(cleanupFile).toContain('MAX_AUTO_NODE_LIFETIME_MS');
      expect(constantsFile).toContain('DEFAULT_MAX_AUTO_NODE_LIFETIME_MS');
    });
  });
});
