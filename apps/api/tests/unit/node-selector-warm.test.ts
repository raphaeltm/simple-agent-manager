/**
 * Source contract tests for warm node selection (T042).
 *
 * Verifies that selectNodeForTaskRun tries warm nodes first
 * before falling through to capacity-based selection.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('warm node selection source contract', () => {
  const selectorFile = readFileSync(resolve(process.cwd(), 'src/services/node-selector.ts'), 'utf8');

  describe('warm node query', () => {
    it('queries D1 for nodes with non-null warm_since', () => {
      expect(selectorFile).toContain('isNotNull(schema.nodes.warmSince)');
    });

    it('only targets running nodes owned by user', () => {
      expect(selectorFile).toContain("eq(schema.nodes.userId, userId)");
      expect(selectorFile).toContain("eq(schema.nodes.status, 'running')");
    });

    it('sorts warm nodes by size/location preference', () => {
      expect(selectorFile).toContain('sortedWarm');
      expect(selectorFile).toContain('preferredSize');
      expect(selectorFile).toContain('preferredLocation');
    });
  });

  describe('tryClaim integration', () => {
    it('calls nodeLifecycle.tryClaim for each warm node', () => {
      expect(selectorFile).toContain('nodeLifecycle.tryClaim');
    });

    it('returns claimed node on success', () => {
      expect(selectorFile).toContain('result.claimed');
    });

    it('continues to next warm node on claim failure', () => {
      // Wrapped in try/catch to handle concurrent claims
      const warmSection = selectorFile.slice(selectorFile.indexOf('Step 0'));
      expect(warmSection).toContain('catch');
    });

    it('falls through to capacity-based selection if no warm node claimed', () => {
      // After the warm node loop, the regular selection logic runs
      const warmSectionEnd = selectorFile.indexOf('Get all running nodes');
      const warmSectionStart = selectorFile.indexOf('Step 0');
      expect(warmSectionStart).toBeGreaterThan(-1);
      expect(warmSectionEnd).toBeGreaterThan(warmSectionStart);
    });
  });

  describe('taskId parameter', () => {
    it('selectNodeForTaskRun accepts optional taskId parameter', () => {
      expect(selectorFile).toContain('taskId?: string');
    });

    it('warm node selection only runs when taskId is provided', () => {
      expect(selectorFile).toContain('if (taskId && env.NODE_LIFECYCLE)');
    });

  });

  describe('NodeSelectorEnv includes NODE_LIFECYCLE', () => {
    it('has optional NODE_LIFECYCLE binding', () => {
      expect(selectorFile).toContain('NODE_LIFECYCLE?: DurableObjectNamespace');
    });
  });
});
