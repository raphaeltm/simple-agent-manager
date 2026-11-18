/**
 * Machine-checked inventory of every `provisionNode` caller (rule 61 req. 2).
 *
 * Tunnel transport behaves differently for the two caller shapes, so a new caller must
 * decide which one it is:
 * - durable (`durableAllocation`): retries resume ONE incarnation, so a failed attempt must
 *   never release that incarnation's tunnel before the VM, and a resume creates only when
 *   no earlier attempt sent the create POST (node-provisioning.ts, node-allocation-recovery.ts);
 * - non-durable: each call mints a fresh incarnation, so a failure before the create POST
 *   releases its tunnel at once.
 * Adding a caller without adding it here fails this test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = new URL('../../../src/', import.meta.url).pathname;

const CALLERS: Record<string, { durable: boolean; reason: string }> = {
  'durable-objects/node-lifecycle-provisioning.ts': {
    durable: true,
    reason:
      'Direct provisioning (POST /api/workspaces needing a node, POST /api/nodes): durable intent, per-attempt deadline, resumes one incarnation.',
  },
  'durable-objects/task-runner/node-provisioning-step.ts': {
    durable: false,
    reason:
      'TaskRunner (chat/task runs, session wake recovery tasks): one call per node record, fresh incarnation per call.',
  },
  'services/deployment-provisioning.ts': {
    durable: false,
    reason:
      'Deployment nodes: passes deploymentContext; tunnel carries the agent channel, app routes stay on the public IP.',
  },
  'services/session-snapshot-upload-relay.ts': {
    durable: false,
    reason: 'Snapshot upload relay node: compensated as a whole on any failure.',
  },
};

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/^\s*(import|export)\b[^;]*?\bfrom\s+['"][^'"]+['"];?/gms, '');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('provisionNode caller inventory', () => {
  const files = sourceFiles(SRC);
  const callers = files
    .filter((path) => !path.endsWith('services/node-provisioning.ts'))
    // Any code reference (a call, a call split across lines, an alias, the function passed as
    // a value), after removing comments and static import/export statements.
    .filter((path) => /\bprovisionNode\b/.test(codeOnly(readFileSync(path, 'utf8'))))
    .map((path) => relative(SRC, path))
    .sort();

  it('scans a real source tree', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('every caller is enumerated with its durability, and every enumerated caller still exists', () => {
    expect(callers).toEqual(Object.keys(CALLERS).sort());
  });

  it('only the enumerated durable caller passes durableAllocation', () => {
    for (const [file, { durable }] of Object.entries(CALLERS)) {
      // The option key in a call, not a mention in a comment.
      expect(/^\s*durableAllocation:/m.test(readFileSync(join(SRC, file), 'utf8')), file).toBe(
        durable
      );
    }
  });
});
