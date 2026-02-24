/**
 * Source contract tests for NodeLifecycle Durable Object (T038).
 *
 * Verifies the NodeLifecycle DO state machine, alarm handling,
 * and D1 warm_since sync.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('NodeLifecycle DO source contract', () => {
  const doFile = readFileSync(resolve(process.cwd(), 'src/durable-objects/node-lifecycle.ts'), 'utf8');
  const serviceFile = readFileSync(resolve(process.cwd(), 'src/services/node-lifecycle.ts'), 'utf8');
  const indexFile = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

  describe('DO class structure', () => {
    it('extends DurableObject', () => {
      expect(doFile).toContain("import { DurableObject } from 'cloudflare:workers'");
      expect(doFile).toContain('extends DurableObject<NodeLifecycleEnv>');
    });

    it('exports the NodeLifecycle class', () => {
      expect(doFile).toContain('export class NodeLifecycle');
    });

    it('re-exported from index.ts', () => {
      expect(indexFile).toContain("export { NodeLifecycle } from './durable-objects/node-lifecycle'");
    });

    it('has NODE_LIFECYCLE binding in Env type', () => {
      expect(indexFile).toContain('NODE_LIFECYCLE: DurableObjectNamespace');
    });
  });

  describe('markIdle method', () => {
    it('accepts nodeId and userId parameters', () => {
      expect(doFile).toContain('async markIdle(nodeId: string, userId: string)');
    });

    it('sets status to warm', () => {
      expect(doFile).toContain("status: 'warm'");
    });

    it('stores warmSince timestamp', () => {
      expect(doFile).toContain('warmSince: now');
    });

    it('schedules alarm at now + timeout', () => {
      expect(doFile).toContain('setAlarm(now + warmTimeout)');
    });

    it('updates D1 warm_since column', () => {
      expect(doFile).toContain('updateD1WarmSince(nodeId');
    });

    it('throws on destroying status', () => {
      expect(doFile).toContain('node_lifecycle_conflict: node is being destroyed');
    });
  });

  describe('markActive method', () => {
    it('sets status to active', () => {
      expect(doFile).toContain("state.status = 'active'");
    });

    it('clears claimedByTask', () => {
      expect(doFile).toContain('state.claimedByTask = null');
    });

    it('cancels alarm via deleteAlarm', () => {
      expect(doFile).toContain('this.ctx.storage.deleteAlarm()');
    });

    it('clears D1 warm_since', () => {
      expect(doFile).toContain('updateD1WarmSince(state.nodeId, null)');
    });
  });

  describe('tryClaim method', () => {
    it('accepts taskId parameter', () => {
      expect(doFile).toContain('async tryClaim(taskId: string)');
    });

    it('returns claimed: true for warm nodes', () => {
      expect(doFile).toContain('{ claimed: true, state: this.toPublicState(state) }');
    });

    it('returns claimed: false for non-warm nodes', () => {
      expect(doFile).toContain("state.status !== 'warm'");
      expect(doFile).toContain('{ claimed: false, state: this.toPublicState(state) }');
    });

    it('sets claimedByTask on successful claim', () => {
      expect(doFile).toContain('state.claimedByTask = taskId');
    });

    it('cancels alarm on successful claim', () => {
      // deleteAlarm is called inside tryClaim after claiming
      const tryClaimSection = doFile.slice(doFile.indexOf('async tryClaim'));
      expect(tryClaimSection).toContain('deleteAlarm()');
    });
  });

  describe('alarm handler', () => {
    it('no-op when node is active (was claimed)', () => {
      const alarmSection = doFile.slice(doFile.indexOf('async alarm()'));
      expect(alarmSection).toContain("status === 'active'");
    });

    it('transitions warm to destroying', () => {
      expect(doFile).toContain("state.status = 'destroying'");
    });

    it('updates D1 node status to stopped', () => {
      expect(doFile).toContain("SET status = 'stopped', warm_since = NULL");
    });

    it('schedules retry alarm on D1 update failure', () => {
      const alarmSection = doFile.slice(doFile.indexOf('async alarm()'));
      expect(alarmSection).toContain('NODE_LIFECYCLE_ALARM_RETRY_MS');
    });
  });

  describe('configurable warm timeout', () => {
    it('uses NODE_WARM_TIMEOUT_MS env var', () => {
      expect(doFile).toContain('NODE_WARM_TIMEOUT_MS');
    });

    it('falls back to DEFAULT_NODE_WARM_TIMEOUT_MS', () => {
      expect(doFile).toContain('DEFAULT_NODE_WARM_TIMEOUT_MS');
    });
  });

  describe('service wrapper', () => {
    it('exports markIdle, markActive, tryClaim, getStatus', () => {
      expect(serviceFile).toContain('export async function markIdle');
      expect(serviceFile).toContain('export async function markActive');
      expect(serviceFile).toContain('export async function tryClaim');
      expect(serviceFile).toContain('export async function getStatus');
    });

    it('uses idFromName(nodeId) for deterministic mapping', () => {
      expect(serviceFile).toContain('env.NODE_LIFECYCLE.idFromName(nodeId)');
    });
  });
});
