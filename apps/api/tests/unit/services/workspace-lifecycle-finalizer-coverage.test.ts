/**
 * Architectural enumeration test for `.claude/rules/61-guards-must-cover-every-runtime.md`.
 *
 * Workspace/node deletion leaks are writer-inventory bugs: adding one terminal
 * teardown path without the shared lifecycle finalizer can leave D1 lifecycle
 * mirrors (agent_sessions, compute_usage, ProjectData session summaries) active
 * after the workspace or node has gone terminal.
 *
 * Every file that writes workspace/node deletion state or calls a terminal
 * teardown primitive must either route through the shared finalizer path or be
 * explicitly allowlisted with a reason. A synthetic unguarded writer assertion
 * keeps the detector honest when patterns change.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectSourceFiles, SRC_ROOT } from '../../helpers/source-tree';

interface TerminalWriterEvidence {
  kind: string;
  excerpt: string;
}

const TERMINAL_WRITER_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'workspace_or_node_deleted_object_write', pattern: /status\s*:\s*['"]deleted['"]/g },
  { kind: 'workspace_or_node_deleted_sql_write', pattern: /status\s*=\s*['"]deleted['"]/g },
  { kind: 'workspace_or_node_drizzle_delete', pattern: /delete\(schema\.(workspaces|nodes)\)/g },
  { kind: 'workspace_or_node_sql_delete', pattern: /DELETE\s+FROM\s+(workspaces|nodes)/gi },
  { kind: 'cf_container_teardown', pattern: /destroyVmAgentContainer\s*\(/g },
  { kind: 'node_stop_helper', pattern: /stopNodeResources\s*\(/g },
  { kind: 'node_delete_helper', pattern: /deleteNodeResources\s*\(/g },
  { kind: 'strict_node_delete_helper', pattern: /deleteNodeResourcesStrict\s*\(/g },
  {
    kind: 'deployment_node_retire_helper',
    pattern: /retireDeletedDeploymentNodeRecord\s*\(/g,
  },
  { kind: 'workspace_delete_helper', pattern: /cleanupWorkspaceForDeletion\s*\(/g },
  { kind: 'task_cleanup_helper', pattern: /cleanupTaskRun\s*\(/g },
  { kind: 'instant_runtime_ended_helper', pattern: /persistRuntimeEnded\s*\(/g },
];

const DIRECT_FINALIZER_SYMBOL = 'finalizeWorkspaceLifecycleClosure';

const SHARED_FINALIZER_ROUTE_SYMBOLS = [
  DIRECT_FINALIZER_SYMBOL,
  'stopNodeResources(',
  'deleteNodeResources(',
  'retireDeletedDeploymentNodeRecord(',
  'cleanupWorkspaceForDeletion(',
  'persistRuntimeEnded(',
];

/**
 * Files that legitimately match terminal-teardown patterns without owning D1
 * lifecycle closure. Keep reasons concrete: each exception is an architectural
 * decision that future deletion writers must not copy blindly.
 */
const ALLOWLIST: Record<string, string> = {
  'durable-objects/task-runner/node-steps.ts':
    'Deletes a freshly-created D1 node row only after provider capacity failure, before any workspace or agent_session exists.',
  'scheduled/d1-retention.ts':
    'Destroys expired cf-container snapshot runtime state after the ProjectData session is stopped; it does not mark workspace/node rows deleted, and the container DO routes D1 runtime termination through persistRuntimeEnded().',
  'services/deployment-provisioning.ts':
    'Abandons a fresh deployment node record after environment-link race loss before any workspace can reference the node.',
  'services/strict-node-deletion.ts':
    'Strict external teardown deliberately does not mutate workspace/node rows; callers update D1 rows and invoke the shared finalizer only after external deletion succeeds.',
  'services/vm-agent-container.ts':
    'Transport wrapper around the VM_AGENT_CONTAINER Durable Object. Runtime-ended D1 writes happen inside the DO via persistRuntimeEnded().',
};

function relativeToSrc(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join('/');
}

function excerptAround(source: string, index: number): string {
  return source.slice(Math.max(0, index - 60), Math.min(source.length, index + 120));
}

function findTerminalWriterEvidence(source: string): TerminalWriterEvidence[] {
  const evidence: TerminalWriterEvidence[] = [];
  for (const { kind, pattern } of TERMINAL_WRITER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      evidence.push({
        kind,
        excerpt: excerptAround(source, match.index ?? 0)
          .replaceAll(/\s+/g, ' ')
          .trim(),
      });
    }
  }
  return evidence;
}

function routesThroughSharedFinalizer(source: string): boolean {
  if (SHARED_FINALIZER_ROUTE_SYMBOLS.some((symbol) => source.includes(symbol))) return true;

  // Task/session terminal cleanup delegates to the central service helper,
  // including dynamic imports from Durable Object modules.
  return (
    source.includes('cleanupTaskRun(') &&
    (source.includes("from './task-runner'") ||
      source.includes("from '../services/task-runner'") ||
      source.includes("from '../../services/task-runner'") ||
      source.includes("import('./task-runner')") ||
      source.includes("import('../services/task-runner')") ||
      source.includes("import('../../services/task-runner')"))
  );
}

describe('workspace/node terminal writers route through shared lifecycle finalizer', () => {
  const terminalWriterFiles = collectSourceFiles(SRC_ROOT)
    .map((file) => {
      const source = readFileSync(file, 'utf8');
      return {
        relative: relativeToSrc(file),
        source,
        evidence: findTerminalWriterEvidence(source),
      };
    })
    .filter((file) => file.evidence.length > 0)
    .sort((a, b) => a.relative.localeCompare(b.relative));

  it('finds the known terminal writer inventory (guards against a silent no-op scan)', () => {
    expect(terminalWriterFiles.map((file) => file.relative)).toEqual(
      expect.arrayContaining([
        'durable-objects/node-lifecycle.ts',
        'durable-objects/vm-agent-container-runtime.ts',
        'routes/nodes.ts',
        'scheduled/node-cleanup/workspace-phases.ts',
        'scheduled/trial-expire.ts',
        'services/instant-session.ts',
        'services/nodes.ts',
        'services/task-runner.ts',
        'services/workspace-cleanup.ts',
      ])
    );
    expect(terminalWriterFiles.length).toBeGreaterThanOrEqual(20);
  });

  it('rejects a synthetic unguarded writer so new unfinalized paths go red', () => {
    const source = `
      await db.update(schema.workspaces).set({ status: 'deleted', updatedAt: now });
      await env.DATABASE.prepare("DELETE FROM nodes WHERE id = ?").bind(nodeId).run();
    `;

    expect(findTerminalWriterEvidence(source).length).toBeGreaterThanOrEqual(2);
    expect(routesThroughSharedFinalizer(source)).toBe(false);
  });

  it('accepts a synthetic writer routed through the shared finalizer', () => {
    const source = `
      await db.update(schema.workspaces).set({ status: 'deleted', updatedAt: now });
      await finalizeWorkspaceLifecycleClosure(env, { workspaceIds: [workspaceId] });
    `;

    expect(findTerminalWriterEvidence(source).length).toBeGreaterThan(0);
    expect(routesThroughSharedFinalizer(source)).toBe(true);
  });

  it('every terminal writer routes through the finalizer or is explicitly allowlisted', () => {
    const unguarded = terminalWriterFiles
      .filter((file) => !(file.relative in ALLOWLIST))
      .filter((file) => !routesThroughSharedFinalizer(file.source))
      .map((file) => ({
        file: file.relative,
        evidence: file.evidence.map((item) => item.kind),
      }));

    expect(
      unguarded,
      'These files write workspace/node terminal state or call a terminal teardown primitive without the shared lifecycle finalizer. ' +
        'Route through finalizeWorkspaceLifecycleClosure(), stopNodeResources(), deleteNodeResources(), cleanupTaskRun(), or add a concrete ALLOWLIST reason.'
    ).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    const terminalWriterSet = new Set(terminalWriterFiles.map((file) => file.relative));
    const stale = Object.keys(ALLOWLIST).filter((relative) => !terminalWriterSet.has(relative));

    expect(
      stale,
      'These allowlist entries no longer match the terminal-writer scan — delete them so exemptions keep documenting real decisions.'
    ).toEqual([]);
  });

  it('allowlist entries carry written reasons', () => {
    for (const [relative, reason] of Object.entries(ALLOWLIST)) {
      expect(relative).toMatch(/\.ts$/);
      expect(reason.trim().split(/\s+/).length).toBeGreaterThanOrEqual(8);
    }
  });
});
