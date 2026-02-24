/**
 * Source contract tests for node cleanup cron sweep (T046).
 *
 * Verifies the cron handler correctly queries for stale warm nodes
 * and max-lifetime auto-provisioned nodes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('node cleanup cron sweep source contract', () => {
  const cleanupFile = readFileSync(resolve(process.cwd(), 'src/scheduled/node-cleanup.ts'), 'utf8');
  const indexFile = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

  describe('stale warm node detection', () => {
    it('queries nodes with non-null warm_since', () => {
      expect(cleanupFile).toContain('isNotNull(schema.nodes.warmSince)');
    });

    it('filters by warm_since < stale threshold', () => {
      expect(cleanupFile).toContain('lt(schema.nodes.warmSince, staleThreshold)');
    });

    it('only targets running nodes', () => {
      expect(cleanupFile).toContain("eq(schema.nodes.status, 'running')");
    });

    it('verifies no active workspaces before destroying', () => {
      expect(cleanupFile).toContain("eq(schema.workspaces.status, 'running')");
      expect(cleanupFile).toContain('wsCount?.count ?? 0) > 0');
    });

    it('clears warm_since if node has active workspaces (data fix)', () => {
      expect(cleanupFile).toContain('warmSince: null, updatedAt:');
    });

    it('calls deleteNodeResources for stale nodes', () => {
      expect(cleanupFile).toContain('deleteNodeResources(node.id, node.userId, env)');
    });
  });

  describe('max lifetime enforcement', () => {
    it('uses MAX_AUTO_NODE_LIFETIME_MS with default', () => {
      expect(cleanupFile).toContain('DEFAULT_MAX_AUTO_NODE_LIFETIME_MS');
      expect(cleanupFile).toContain('MAX_AUTO_NODE_LIFETIME_MS');
    });

    it('queries auto-provisioned nodes via tasks table', () => {
      expect(cleanupFile).toContain('schema.tasks.autoProvisionedNodeId');
    });

    it('destroys nodes past max lifetime regardless of warm status', () => {
      expect(cleanupFile).toContain('lifetimeThreshold');
      expect(cleanupFile).toContain('node.createdAt > lifetimeThreshold');
    });
  });

  describe('error handling and idempotency', () => {
    it('continues sweep on individual node destruction failure', () => {
      expect(cleanupFile).toContain('result.errors++');
    });

    it('logs errors with node ID', () => {
      expect(cleanupFile).toContain('failed to destroy stale warm node');
      expect(cleanupFile).toContain('failed to destroy max-lifetime node');
    });

    it('returns structured result with counts', () => {
      expect(cleanupFile).toContain('staleDestroyed');
      expect(cleanupFile).toContain('lifetimeDestroyed');
      expect(cleanupFile).toContain('errors');
    });
  });

  describe('cron integration', () => {
    it('is imported and called in scheduled handler', () => {
      expect(indexFile).toContain("import { runNodeCleanupSweep } from './scheduled/node-cleanup'");
      expect(indexFile).toContain('runNodeCleanupSweep(env)');
    });

    it('results are logged in cron output', () => {
      expect(indexFile).toContain('staleDestroyed');
      expect(indexFile).toContain('lifetimeDestroyed');
    });
  });

  describe('configurable grace period', () => {
    it('uses NODE_WARM_GRACE_PERIOD_MS env var', () => {
      expect(cleanupFile).toContain('NODE_WARM_GRACE_PERIOD_MS');
    });

    it('falls back to DEFAULT_NODE_WARM_GRACE_PERIOD_MS', () => {
      expect(cleanupFile).toContain('DEFAULT_NODE_WARM_GRACE_PERIOD_MS');
    });
  });
});
