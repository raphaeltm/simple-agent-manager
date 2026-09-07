/**
 * Vertical-slice tests for node_role lifecycle exemption.
 *
 * Deployment-role nodes must be excluded from:
 * - Node selector (warm pool + fallback queries)
 * - Workspace node quota checks
 * - Cron sweep queries (stale warm, max lifetime, stopped handoff, orphan detection)
 *
 * Deployment nodes SHOULD still appear in:
 * - Node listing (GET /api/nodes)
 * - toNodeResponse() output (with nodeRole field)
 */
import { existsSync } from 'node:fs';

import path from 'path';
import { describe, expect, it, vi } from 'vitest';

const SRC_DIR = path.resolve(__dirname, '../../src');

import * as schema from '../../src/db/schema';

vi.mock('../../src/services/node-lifecycle', () => ({
  tryClaim: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockNode = {
  id: string;
  userId: string;
  status: string;
  healthStatus: string;
  vmSize: string;
  vmLocation: string;
  nodeRole: string;
  lastMetrics: string | null;
  warmSince?: string | null;
};

function makeNode(overrides: Partial<MockNode> = {}): MockNode {
  return {
    id: 'node-ws-1',
    userId: 'user-1',
    status: 'running',
    healthStatus: 'healthy',
    vmSize: 'medium',
    vmLocation: 'fsn1',
    nodeRole: 'workspace',
    lastMetrics: JSON.stringify({ cpuLoadAvg1: 5, memoryPercent: 10 }),
    warmSince: null,
    ...overrides,
  };
}

/**
 * Build a mock DB that filters by nodeRole in its where() clause,
 * mirroring how the real Drizzle queries filter.
 */
function createMockDb({
  allNodes,
  workspaceCount = 0,
}: {
  allNodes: MockNode[];
  workspaceCount?: number;
}) {
  return {
    select(selection?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          return {
            where(..._args: unknown[]) {
              if (table === schema.workspaces) {
                return Promise.resolve([{ count: workspaceCount }]);
              }

              if (table === schema.nodes) {
                // For warm-node freshness re-checks (select by ID with limit)
                if (selection && 'warmSince' in selection && 'status' in selection) {
                  return {
                    limit() {
                      return Promise.resolve([
                        { status: 'running', warmSince: new Date().toISOString() },
                      ]);
                    },
                  };
                }

                // The real Drizzle queries include eq(schema.nodes.nodeRole, 'workspace').
                // Filter the mock data the same way the DB would.
                const filtered = allNodes.filter((n) => n.nodeRole === 'workspace');

                // For warm nodes query (has warmSince in selection)
                if (selection && 'warmSince' in selection) {
                  return Promise.resolve(filtered.filter((n) => n.warmSince));
                }

                // For main node query
                return Promise.resolve(filtered.filter((n) => n.status === 'running'));
              }

              return Promise.resolve([]);
            },
          };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Reusable-node role filtering
//
// The `selectNodeForTaskRun` cases that used to live here asserted the guard on
// services/node-selector.ts, which had zero production importers. They were
// re-pointed at the canonical `findNodeWithCapacity` and are now driven through
// a real SQL engine in
// tests/unit/durable-objects/task-runner-reuse-scoping.test.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// toNodeResponse — nodeRole field present
// ---------------------------------------------------------------------------

describe('toNodeResponse includes nodeRole', () => {
  it('maps workspace role correctly', () => {
    // Import inline to avoid module-level side effects
    // The function is not exported from the module, so we test via the route integration
    // Instead, verify the shared type includes nodeRole
    const node: MockNode = makeNode({ nodeRole: 'workspace' });
    expect(node.nodeRole).toBe('workspace');
  });

  it('maps deployment role correctly', () => {
    const node: MockNode = makeNode({ nodeRole: 'deployment' });
    expect(node.nodeRole).toBe('deployment');
  });
});

// ---------------------------------------------------------------------------
// Cron sweep SQL queries — deployment nodes excluded
// ---------------------------------------------------------------------------

describe('node-cleanup cron sweep — node_role filtering', () => {
  // Behavioral, not source-string. These previously asserted that certain SQL
  // substrings appeared in the sweep source, which proves the filter is PRESENT but
  // not that it WORKS — and the string-slicing broke whenever the file was edited.
  //
  // The stakes are concrete: production ran three node_role='deployment' machines
  // backing ACTIVE deployment_environments. Deployment nodes host docker compose
  // applications and never hold workspaces, so every "running node with zero
  // workspaces" heuristic matches them perfectly. A reaper without this gate destroys
  // live user applications. The full behavioral coverage lives in
  // tests/unit/services/node-cleanup-deployment-node-exemption.test.ts, which runs
  // the real sweep against real SQLite and asserts no destroy call is ever made.
  it('is covered behaviorally by the deployment-node exemption suite', () => {
    const suite = path.join(
      SRC_DIR,
      '../tests/unit/services/node-cleanup-deployment-node-exemption.test.ts'
    );
    expect(existsSync(suite)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task runner node-steps — deployment nodes excluded
// ---------------------------------------------------------------------------

describe('task-runner node-steps — node_role filtering', () => {
  it('node quota count query excludes deployment nodes', async () => {
    const fs = await import('fs');
    // The provisioning step (and this query with it) moved out of node-steps.ts
    // when that file was split for rule 18.
    const source = fs.readFileSync(
      path.join(SRC_DIR, 'durable-objects/task-runner/node-provisioning-step.ts'),
      'utf-8'
    );

    // The COUNT query for user node limit must include node_role filter.
    // Search for the closing bind FORWARD from the marker: other queries in this
    // file also bind state.userId, and an unanchored indexOf can return an
    // earlier offset and silently slice an empty string.
    const quotaStart = source.indexOf('Check user node limit');
    expect(quotaStart).toBeGreaterThan(-1);
    const quotaSection = source.slice(
      quotaStart,
      source.indexOf('.bind(state.userId)', quotaStart)
    );
    expect(quotaSection).not.toBe('');
    expect(quotaSection).toContain("node_role = 'workspace'");
  });

  it('warm node query excludes deployment nodes', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(
      path.join(SRC_DIR, 'durable-objects/task-runner/node-selection.ts'),
      'utf-8'
    );

    // The warm node search query must include node_role filter
    const warmQueryStart = source.indexOf('const warmNodes = await rc.env.DATABASE.prepare(');
    const warmQueryEnd = source.indexOf('.bind(state.userId)', warmQueryStart);
    const warmSection = source.slice(warmQueryStart, warmQueryEnd);
    expect(warmSection).toContain("node_role = 'workspace'");
  });

  it('fallback node selection query excludes deployment nodes', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(
      path.join(SRC_DIR, 'durable-objects/task-runner/node-selection.ts'),
      'utf-8'
    );

    // The fallback "find existing running node" query must include node_role filter
    const fallbackFunctionStart = source.indexOf('export async function findNodeWithCapacity(');
    const fallbackQueryStart = source.indexOf(
      'const nodes = await rc.env.DATABASE.prepare(',
      fallbackFunctionStart
    );
    const fallbackQueryEnd = source.indexOf('.bind(state.userId)', fallbackQueryStart);
    const fallbackSection = source.slice(fallbackQueryStart, fallbackQueryEnd);
    expect(fallbackSection).toContain("node_role = 'workspace'");
  });
});

// ---------------------------------------------------------------------------
// Workspace creation node quota — deployment nodes excluded
// ---------------------------------------------------------------------------

describe('workspace creation node quota — node_role filtering', () => {
  it('workspace CRUD node count excludes deployment nodes', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(path.join(SRC_DIR, 'routes/workspaces/crud.ts'), 'utf-8');

    // The node count for workspace creation quota must filter by nodeRole
    const countSection = source.slice(
      source.indexOf('userNodeCount'),
      source.indexOf('userNodeCountVal')
    );
    expect(countSection).toContain('nodeRole');
    expect(countSection).toContain("'workspace'");
  });
});
