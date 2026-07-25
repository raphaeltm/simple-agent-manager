/**
 * Regression test: the re-sync step in deploy-reusable.yml must forward
 * every optional env var that the initial sync step forwards.
 *
 * Before this fix, 16 optional env vars (container/sandbox config) were
 * present in the initial sync but missing from the re-sync on first deploy,
 * silently losing operator-configured overrides.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('deploy-reusable.yml sync step env parity', () => {
  const workflowPath = resolve(__dirname, '../../../../.github/workflows/deploy-reusable.yml');
  const workflow = readFileSync(workflowPath, 'utf-8');

  /**
   * Extract the env: block from a GitHub Actions step by its exact name.
   * Steps may have `if:`, `run:`, `working-directory:` etc between `name:` and `env:`.
   */
  function extractEnvBlock(stepName: string): Set<string> {
    const lines = workflow.split('\n');
    let inStep = false;
    let inEnv = false;
    let envIndent = 0;
    const vars = new Set<string>();

    for (const line of lines) {
      // Detect the start of the target step
      if (line.includes(`- name: ${stepName}`)) {
        inStep = true;
        inEnv = false;
        continue;
      }

      if (inStep) {
        // Detect start of a new step (ends this step's scope)
        if (line.match(/^\s+- name: /) && !line.includes(stepName)) {
          break;
        }

        // Detect `env:` key within this step
        const envMatch = line.match(/^(\s+)env:\s*$/);
        if (envMatch) {
          inEnv = true;
          envIndent = envMatch[1].length;
          continue;
        }

        if (inEnv) {
          // Lines inside the env block are indented deeper than `env:`
          const varMatch = line.match(/^(\s+)(\w+):/);
          if (varMatch && varMatch[1].length > envIndent) {
            vars.add(varMatch[2]);
          } else if (line.trim() !== '' && !line.match(/^\s{1,}#/)) {
            // Non-empty, non-comment line at same or lesser indent => env block ended
            const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
            if (indent <= envIndent) {
              inEnv = false;
            }
          }
        }
      }
    }

    return vars;
  }

  it('re-sync step forwards every optional env var from the initial sync step', () => {
    const initialSyncVars = extractEnvBlock('Sync Wrangler Config (API + Tail Worker)');
    const resyncVars = extractEnvBlock('Re-sync Wrangler Config (add tail_consumers)');

    expect(initialSyncVars.size).toBeGreaterThan(0);
    expect(resyncVars.size).toBeGreaterThan(0);

    const missingFromResync = [...initialSyncVars].filter((v) => !resyncVars.has(v));
    expect(missingFromResync).toEqual([]);
  });

  it('both sync steps include container/sandbox optional env vars', () => {
    const requiredOptionalVars = [
      'CF_CONTAINER_ENABLED',
      'CF_CONTAINER_SLEEP_AFTER',
      'CF_CONTAINER_PORT_READY_TIMEOUT_MS',
      'CF_CONTAINER_WAKE_TIMEOUT_MS',
      'CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS',
      'CF_CONTAINER_CLONE_FILTER',
      'CF_CONTAINER_VM_AGENT_PORT',
      'SANDBOX_ENABLED',
      'SANDBOX_EXEC_TIMEOUT_MS',
      'SANDBOX_VM_AGENT_PORT',
      'MAX_CONCURRENT_SETUP_SESSIONS',
      'SETUP_SESSION_TTL_MS',
      'SETUP_SESSION_CAPTURE_POLL_MS',
      'CODEX_DEVICE_AUTH_REQUEST_TIMEOUT_MS',
      'SETUP_SESSION_SWEEP_MAX_CANDIDATES',
      'POOL_LEASE_BUFFER_MS',
    ];

    const resyncVars = extractEnvBlock('Re-sync Wrangler Config (add tail_consumers)');

    for (const v of requiredOptionalVars) {
      expect(resyncVars.has(v), `re-sync step must include ${v}`).toBe(true);
    }
  });
});
