import { describe, expect, it } from 'vitest';

import {
  ALLOCATION_WRITER_INVENTORY,
  formatBoundaryViolations,
  scanAllocationWriters,
  scanLegacyAuthority,
  scanRepositoryNodePoolBoundary,
  type SourceFileInput,
  validateAllocationWriterInventory,
} from '../../../../../scripts/quality/node-pool-boundary';

describe('node-pool legacy compatibility boundary', () => {
  it('detects forbidden legacy-size authority through the repository scanner', () => {
    const forbiddenFixture: SourceFileInput = {
      filePath: 'apps/api/src/services/compute-usage.ts',
      source: `
        import { getVcpuCount } from '@simple-agent-manager/shared';

        export function deriveBillableCapacity(input: { vmSize: string; cloudProvider: string }) {
          return getVcpuCount(input.vmSize, input.cloudProvider);
        }
      `,
    };

    expect(formatBoundaryViolations(scanLegacyAuthority([forbiddenFixture]))).toEqual([
      "apps/api/src/services/compute-usage.ts:2:18 imports legacy VM-size authority getVcpuCount: import { getVcpuCount } from '@simple-agent-manager/shared';",
      'apps/api/src/services/compute-usage.ts:5:18 calls legacy VM-size authority getVcpuCount: return getVcpuCount(input.vmSize, input.cloudProvider);',
      'apps/api/src/services/compute-usage.ts:5:37 reads legacy vmSize in placement/provider/metering authority scope: return getVcpuCount(input.vmSize, input.cloudProvider);',
    ]);
  });

  it('allows named compatibility modules and explicitly labeled historical displays', () => {
    const compatibilityFixture: SourceFileInput = {
      filePath: 'apps/api/src/services/legacy-node-pool-compatibility.ts',
      source: `
        import { getVcpuCount } from '@simple-agent-manager/shared';
        export const legacy = getVcpuCount('medium', 'hetzner');
      `,
    };
    const displayFixture: SourceFileInput = {
      filePath: 'apps/api/src/services/node-usage.ts',
      source: `
        export function displayHistoricalNode(node: { vmSize: string }) {
          // node-pool-boundary: historical display
          return node.vmSize;
        }
      `,
    };
    const responsiveFixture: SourceFileInput = {
      filePath: 'apps/api/src/services/workspace-resource-capacity.ts',
      source: `
        export const style = { inlineSize: '100%', blockSize: 'auto' };
      `,
    };

    expect(scanLegacyAuthority([compatibilityFixture, displayFixture, responsiveFixture])).toEqual(
      []
    );
  });

  it('keeps allocation writers matched to a narrow inventory', () => {
    const writers = scanAllocationWriters([
      {
        filePath: 'apps/api/src/services/workspace-placement.ts',
        source: `
          export async function reserveWorkspacePlacement(database: D1Database) {
            await database.prepare(\`
              INSERT INTO workspaces (id, resolved_reservation_json)
              SELECT ?, ?
            \`).bind('workspace-1', '{}').run();
          }
        `,
      },
      {
        filePath: 'apps/api/src/services/compute-usage.ts',
        source: `
          import * as schema from '../db/schema';
          export async function startComputeTracking(db: Db) {
            const providerInstanceVcpuCount = 2;
            await db.insert(schema.computeUsage).values({ providerInstanceVcpuCount });
          }
        `,
      },
    ]);

    expect(
      writers.map(({ filePath, table, writerKind }) => ({ filePath, table, writerKind }))
    ).toEqual([
      {
        filePath: 'apps/api/src/services/workspace-placement.ts',
        table: 'workspaces',
        writerKind: 'sql-insert',
      },
      {
        filePath: 'apps/api/src/services/compute-usage.ts',
        table: 'compute_usage',
        writerKind: 'drizzle-insert',
      },
    ]);
  });

  it('rejects unexpected allocation writers through the same scanner', () => {
    const unexpectedWriter: SourceFileInput = {
      filePath: 'apps/api/src/services/unowned-allocation.ts',
      source: `
        import * as schema from '../db/schema';
        export async function createTaskDirectly(db: Db) {
          await db.insert(schema.tasks).values({ id: 'task-1' });
        }
      `,
    };

    expect(
      formatBoundaryViolations(validateAllocationWriterInventory([unexpectedWriter], []))
    ).toEqual([
      "apps/api/src/services/unowned-allocation.ts:4:17 unexpected tasks drizzle-insert; add a narrow inventory role or route through a canonical service: await db.insert(schema.tasks).values({ id: 'task-1' });",
    ]);
  });

  it('rejects inventory entries whose canonical evidence disappeared', () => {
    const missingEvidence: SourceFileInput = {
      filePath: 'apps/api/src/services/workspace-placement.ts',
      source: `
        export async function reserveWorkspacePlacement(database: D1Database) {
          await database.prepare(\`INSERT INTO workspaces (id) SELECT ?\`).bind('workspace-1').run();
        }
      `,
    };

    expect(
      formatBoundaryViolations(
        validateAllocationWriterInventory(
          [missingEvidence],
          [
            {
              filePath: 'apps/api/src/services/workspace-placement.ts',
              table: 'workspaces',
              role: 'canonical final workspace placement writer',
              requiredEvidence: ['resolved_reservation_json'],
            },
          ]
        )
      )
    ).toEqual([
      'apps/api/src/services/workspace-placement.ts:3:34 workspaces writer role "canonical final workspace placement writer" is missing required evidence: resolved_reservation_json: await database.prepare(`INSERT INTO workspaces (id) SELECT ?`).bind(\'workspace-1\').run();',
    ]);
  });

  it('documents the checked allocation writer inventory', () => {
    expect(
      ALLOCATION_WRITER_INVENTORY.map(({ filePath, table, role, canonicalService }) => ({
        filePath,
        table,
        role,
        canonicalService,
      }))
    ).toMatchInlineSnapshot(`
      [
        {
          "canonicalService": "resolveTaskStartPlacement -> startTaskRunnerDO",
          "filePath": "apps/api/src/routes/tasks/submit.ts",
          "role": "user task submit route adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "resolveTaskStartPlacement -> startTaskRunnerDO",
          "filePath": "apps/api/src/routes/mcp/dispatch-tool.ts",
          "role": "MCP dispatch route adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "resolveTaskStartPlacement -> startTaskRunnerDO",
          "filePath": "apps/api/src/routes/mcp/orchestration-tools.ts",
          "role": "MCP orchestration retry adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "resolveTaskStartPlacement -> startTaskRunnerDO",
          "filePath": "apps/api/src/services/trigger-submit.ts",
          "role": "trigger submission adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "resolveTaskStartPlacement -> startTaskRunnerDO",
          "filePath": "apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts",
          "role": "SAM session dispatch tool adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "resolveTaskStartPlacement -> startTaskRunnerDO",
          "filePath": "apps/api/src/durable-objects/sam-session/tools/retry-subtask.ts",
          "role": "SAM session subtask retry adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "resolveTaskStartPlacement -> startTaskRunnerDO",
          "filePath": "apps/api/src/services/session-recovery.ts",
          "role": "sleeping session wake recovery adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "explicit legacy workspace route adapter",
          "filePath": "apps/api/src/routes/workspaces/crud.ts",
          "role": "legacy direct workspace conversation task adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "explicit non-running task creation adapter",
          "filePath": "apps/api/src/routes/tasks/crud.ts",
          "role": "task metadata CRUD adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "explicit chat task adapter",
          "filePath": "apps/api/src/routes/chat.ts",
          "role": "conversation task compatibility adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "explicit chat-start task adapter",
          "filePath": "apps/api/src/routes/chat-start.ts",
          "role": "conversation start compatibility adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "explicit idea adapter",
          "filePath": "apps/api/src/routes/mcp/idea-tools.ts",
          "role": "MCP idea task materialization adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "explicit idea adapter",
          "filePath": "apps/api/src/durable-objects/sam-session/tools/create-idea.ts",
          "role": "SAM session idea task materialization adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "explicit diagnostic adapter",
          "filePath": "apps/api/src/services/debug-agent.ts",
          "role": "debug diagnosis task adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "explicit feedback adapter",
          "filePath": "apps/api/src/services/platform-feedback-triage/runner.ts",
          "role": "platform feedback triage task adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "explicit feedback adapter",
          "filePath": "apps/api/src/services/platform-feedback-incidents/user-report.ts",
          "role": "platform feedback incident task adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "explicit trial runtime adapter",
          "filePath": "apps/api/src/services/trial/trial-runner.ts",
          "role": "trial orchestration task adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "explicit repair adapter",
          "filePath": "apps/api/src/services/session-task-repair.ts",
          "role": "session task repair adapter",
          "table": "tasks",
        },
        {
          "canonicalService": "createNodeRecord",
          "filePath": "apps/api/src/services/nodes.ts",
          "role": "canonical node row writer",
          "table": "nodes",
        },
        {
          "canonicalService": "explicit legacy workspace route adapter",
          "filePath": "apps/api/src/routes/workspaces/crud.ts",
          "role": "legacy direct workspace route adapter",
          "table": "workspaces",
        },
        {
          "canonicalService": "explicit cf-container runtime adapter",
          "filePath": "apps/api/src/services/instant-session.ts",
          "role": "Cloudflare container instant runtime adapter",
          "table": "workspaces",
        },
        {
          "canonicalService": "explicit trial runtime adapter",
          "filePath": "apps/api/src/durable-objects/trial-orchestrator/steps.ts",
          "role": "trial runtime workspace adapter",
          "table": "workspaces",
        },
        {
          "canonicalService": "reserveWorkspacePlacement",
          "filePath": "apps/api/src/services/workspace-placement.ts",
          "role": "canonical final workspace placement writer",
          "table": "workspaces",
        },
        {
          "canonicalService": "startComputeTracking",
          "filePath": "apps/api/src/services/compute-usage.ts",
          "role": "canonical compute metering row writer",
          "table": "compute_usage",
        },
      ]
    `);
  });

  it('fails while canonical node-pool authority leaks remain in source', () => {
    expect(formatBoundaryViolations(scanRepositoryNodePoolBoundary())).toEqual([]);
  });
});
