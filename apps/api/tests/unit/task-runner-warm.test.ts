/**
 * Source contract tests for node warm marking after task completion (T044).
 *
 * Verifies that cleanupAutoProvisionedNode calls markIdle instead of
 * immediate destruction, enabling warm node pooling.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('task runner warm node marking source contract', () => {
  const taskRunnerFile = readFileSync(resolve(process.cwd(), 'src/services/task-runner.ts'), 'utf8');

  describe('warm pooling integration', () => {
    it('imports nodeLifecycleService', () => {
      expect(taskRunnerFile).toContain("import * as nodeLifecycleService from './node-lifecycle'");
    });

    it('calls markIdle instead of immediate stopNodeResources', () => {
      // The cleanupAutoProvisionedNode function should call markIdle
      const cleanupSection = taskRunnerFile.slice(
        taskRunnerFile.indexOf('cleanupAutoProvisionedNode')
      );
      expect(cleanupSection).toContain('nodeLifecycleService.markIdle(env, nodeId, userId)');
    });

    it('still checks for active workspaces before marking idle', () => {
      expect(taskRunnerFile).toContain('activeWorkspaces.length > 0');
    });

    it('falls back to stopNodeResources on markIdle failure', () => {
      // If DO fails, fallback to direct stop
      const cleanupSection = taskRunnerFile.slice(
        taskRunnerFile.indexOf('function cleanupAutoProvisionedNode')
      );
      expect(cleanupSection).toContain('Failed to mark node as warm; falling back to immediate stop');
      expect(cleanupSection).toContain('stopNodeResources(nodeId, userId, env)');
    });

    it('markIdle failure does not propagate (best-effort)', () => {
      const cleanupSection = taskRunnerFile.slice(
        taskRunnerFile.indexOf('function cleanupAutoProvisionedNode')
      );
      // Outer catch catches markIdle errors
      expect(cleanupSection).toContain('catch (err)');
      // Inner catch catches fallback errors
      expect(cleanupSection).toContain('// Best effort');
    });
  });

  describe('node stays available for fast reuse', () => {
    it('function doc mentions warm pooling', () => {
      expect(taskRunnerFile).toContain('marks the node as warm (idle) via the NodeLifecycle DO');
    });

    it('function doc mentions DO alarm for teardown', () => {
      expect(taskRunnerFile).toContain('DO alarm handles eventual');
    });
  });
});
