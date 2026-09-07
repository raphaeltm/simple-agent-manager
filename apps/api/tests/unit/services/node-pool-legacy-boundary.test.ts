import { describe, expect, it } from 'vitest';

import {
  ALLOCATION_ENTRYPOINT_INVENTORY,
  ALLOCATION_WRITER_INVENTORY,
  type AllocationEntrypointInventoryEntry,
  type AllocationWriterInventoryEntry,
  formatBoundaryViolations,
  isLegacyAuthorityScope,
  REVIEWED_LEGACY_REQUEST_VALIDATORS,
  scanAllocationEntrypoints,
  scanAllocationWriters,
  scanLegacyAuthority,
  scanRepositoryNodePoolBoundary,
  type SourceFileInput,
  sqlInsertTables,
  validateAllocationEntrypointInventory,
  validateAllocationWriterInventory,
} from '../../../../../scripts/quality/node-pool-boundary';

function file(filePath: string, source: string): SourceFileInput {
  return { filePath, source };
}

function authorityFindings(...files: SourceFileInput[]): string[] {
  return formatBoundaryViolations(scanLegacyAuthority(files));
}

function writerShapes(files: SourceFileInput[]) {
  return scanAllocationWriters(files).map(({ filePath, table, writerKind, owner }) => ({
    filePath,
    table,
    writerKind,
    owner,
  }));
}

describe('node-pool legacy authority: symbol resolution', () => {
  it('resolves a renamed named import and its call', () => {
    const findings = authorityFindings(
      file(
        'apps/api/src/services/compute-usage.ts',
        [
          "import { getVcpuCount as count } from '@simple-agent-manager/shared';",
          'export function derive(size: string, provider: string) {',
          '  return count(size, provider);',
          '}',
        ].join('\n')
      )
    );

    expect(findings).toEqual([
      "apps/api/src/services/compute-usage.ts:1:10 imports legacy VM-size authority getVcpuCount: import { getVcpuCount as count } from '@simple-agent-manager/shared';",
      'apps/api/src/services/compute-usage.ts:3:10 calls legacy VM-size authority getVcpuCount: return count(size, provider);',
    ]);
  });

  it('resolves a namespace-qualified authority call', () => {
    const findings = authorityFindings(
      file(
        'apps/api/src/services/compute-usage.ts',
        [
          "import * as legacy from '@simple-agent-manager/shared';",
          'export function derive(size: string, provider: string) {',
          '  return legacy.getVcpuCount(size, provider);',
          '}',
        ].join('\n')
      )
    );

    expect(findings).toEqual([
      'apps/api/src/services/compute-usage.ts:3:17 calls legacy VM-size authority getVcpuCount: return legacy.getVcpuCount(size, provider);',
    ]);
  });

  it('resolves a destructured legacy-size alias used as a catalog key', () => {
    const findings = authorityFindings(
      file(
        'apps/api/src/services/node-selector.ts',
        [
          'export function pick(node: { vmSize: string }, offers: Record<string, number>) {',
          '  const { vmSize: size } = node;',
          '  return offers[size];',
          '}',
        ].join('\n')
      )
    );

    expect(findings).toEqual([
      'apps/api/src/services/node-selector.ts:3:17 uses a legacy VM size as a catalog/capacity lookup key: return offers[size];',
    ]);
  });

  it('resolves a legacy-size alias bound by a plain property read', () => {
    const findings = authorityFindings(
      file(
        'apps/api/src/services/node-selector.ts',
        [
          'export function pick(node: { vmSize: string }, offers: Record<string, number>) {',
          '  const size = node.vmSize;',
          '  return offers[size];',
          '}',
        ].join('\n')
      )
    );

    expect(findings).toContain(
      'apps/api/src/services/node-selector.ts:3:17 uses a legacy VM size as a catalog/capacity lookup key: return offers[size];'
    );
  });
});

describe('node-pool legacy authority: scope coverage', () => {
  it('covers a newly created canonical placement module by family, not by filename list', () => {
    expect(isLegacyAuthorityScope('apps/api/src/services/placement-ranking.ts')).toBe(true);
    expect(isLegacyAuthorityScope('apps/api/src/services/capacity-pool-refresh.ts')).toBe(true);
    expect(isLegacyAuthorityScope('apps/api/src/services/node-metering-rollup.ts')).toBe(true);
    expect(isLegacyAuthorityScope('packages/providers/src/anything.ts')).toBe(true);
    expect(isLegacyAuthorityScope('apps/api/src/services/github-app.ts')).toBe(false);
  });

  it('flags a brand-new placement module that never existed when the gate was written', () => {
    const findings = authorityFindings(
      file(
        'apps/api/src/services/placement-ranking.ts',
        [
          'export function rank(node: { vmSize: string }, offers: Record<string, number>) {',
          '  return offers[node.vmSize];',
          '}',
        ].join('\n')
      )
    );

    expect(findings).toEqual([
      'apps/api/src/services/placement-ranking.ts:2:17 uses a legacy VM size as a catalog/capacity lookup key: return offers[node.vmSize];',
    ]);
  });

  it('flags an authority sink even outside canonical scope', () => {
    const findings = authorityFindings(
      file(
        'apps/api/src/routes/experimental.ts',
        'export function eligible(node: { vmSize: string }, want: string) {\n  return node.vmSize === want;\n}\n'
      )
    );

    expect(findings).toEqual([
      'apps/api/src/routes/experimental.ts:2:10 compares a legacy VM size to decide eligibility or ranking: return node.vmSize === want;',
    ]);
  });
});

describe('node-pool legacy authority: forbidden authority vs legitimate adapter code', () => {
  it('does not flag type positions or audit metadata', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/placement-resolver.ts',
          [
            "type LegacyInput = Pick<{ vmSize: string; id: string }, 'vmSize'>;",
            'export function audit(input: LegacyInput) {',
            '  return { deprecatedSize: input.vmSize };',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([]);
  });

  it('does not flag persisted legacy columns bound into an insert', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/workspace-placement.ts',
          [
            'export async function reserve(db: D1Database, input: { vmSize: string }) {',
            "  await db.prepare('INSERT INTO workspaces (vm_size) VALUES (?)').bind(input.vmSize).run();",
            '}',
          ].join('\n')
        )
      )
    ).toEqual([]);
  });

  it('does not flag persisted legacy columns written through a drizzle values() object', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/compute-usage.ts',
          [
            'export async function track(db: Db, input: { vmSize: string }) {',
            '  await db.insert(schema.computeUsage).values({ serverType: input.vmSize });',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([]);
  });

  it('does not flag the compatibility adapter collecting legacy sizes at their own layer', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/placement-resolver.ts',
          [
            'export function collect(explicit: { vmSize?: string; vmSizeSource?: string }) {',
            '  const legacyVmSizes: Record<string, string> = {};',
            '  if (explicit.vmSize) {',
            "    legacyVmSizes[explicit.vmSizeSource ?? 'task'] = explicit.vmSize;",
            '  }',
            '  return legacyVmSizes;',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([]);
  });

  it('does not flag writing a legacy value into a legacy-named field', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/durable-objects/task-runner/node-provisioning-target.ts',
          [
            'export function adapt(state: { config: { vmSize: string } }, candidate: { machineSize?: string }) {',
            '  state.config.vmSize = candidate.machineSize ?? state.config.vmSize;',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([]);
  });

  it('does not flag a presence check on a deprecated request field', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/routes/triggers/crud.ts',
          [
            'export function apply(body: { vmSizeOverride?: string }, updates: Record<string, unknown>) {',
            '  if (body.vmSizeOverride !== undefined) updates.vmSizeOverride = body.vmSizeOverride;',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([]);
  });

  it('does not flag a SQL statement that merely mentions the legacy column name', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/nodes.ts',
          "export const SELECT_NODE = 'SELECT id, vm_size FROM nodes WHERE id = ?';\n"
        )
      )
    ).toEqual([]);
  });

  it('still flags a catalog lookup inside a file that also has legitimate adapter code', () => {
    const findings = authorityFindings(
      file(
        'apps/api/src/services/placement-resolver.ts',
        [
          'export function resolve(input: { vmSize: string }, offers: Record<string, number>) {',
          '  const audit = { deprecatedSize: input.vmSize };',
          '  return { audit, capacity: offers[input.vmSize] };',
          '}',
        ].join('\n')
      )
    );

    expect(findings).toEqual([
      'apps/api/src/services/placement-resolver.ts:3:36 uses a legacy VM size as a catalog/capacity lookup key: return { audit, capacity: offers[input.vmSize] };',
    ]);
  });
});

describe('node-pool legacy authority: reviewed exceptions are narrow', () => {
  const validatorSource = [
    'export function parseDispatchTaskParams(params: { vmSize?: string }) {',
    '  if (params.vmSize !== undefined) {',
    "    if (!['small', 'medium', 'large'].includes(params.vmSize)) throw new Error('bad size');",
    '  }',
    '  return params;',
    '}',
  ].join('\n');

  it('exempts a reviewed deprecated-field validator', () => {
    expect(
      authorityFindings(file('apps/api/src/routes/mcp/dispatch-tool-params.ts', validatorSource))
    ).toEqual([]);
  });

  it('flags the identical validation in an unreviewed function', () => {
    const findings = authorityFindings(
      file(
        'apps/api/src/routes/mcp/dispatch-tool-params.ts',
        validatorSource.replace('parseDispatchTaskParams', 'parseSomethingElse')
      )
    );

    expect(findings).toEqual([
      "apps/api/src/routes/mcp/dispatch-tool-params.ts:3:48 compares a legacy VM size to decide eligibility or ranking: if (!['small', 'medium', 'large'].includes(params.vmSize)) throw new Error('bad size');",
    ]);
  });

  it('does not let a reviewed validator hide a catalog lookup or an authority call', () => {
    const findings = authorityFindings(
      file(
        'apps/api/src/routes/mcp/dispatch-tool-params.ts',
        [
          "import { getVcpuCount } from '@simple-agent-manager/shared';",
          'export function parseDispatchTaskParams(params: { vmSize: string }, offers: Record<string, number>) {',
          '  const capacity = offers[params.vmSize];',
          "  return capacity ?? getVcpuCount(params.vmSize, 'hetzner');",
          '}',
        ].join('\n')
      )
    );

    expect(findings).toEqual([
      "apps/api/src/routes/mcp/dispatch-tool-params.ts:1:10 imports legacy VM-size authority getVcpuCount: import { getVcpuCount } from '@simple-agent-manager/shared';",
      'apps/api/src/routes/mcp/dispatch-tool-params.ts:3:27 uses a legacy VM size as a catalog/capacity lookup key: const capacity = offers[params.vmSize];',
      "apps/api/src/routes/mcp/dispatch-tool-params.ts:4:22 calls legacy VM-size authority getVcpuCount: return capacity ?? getVcpuCount(params.vmSize, 'hetzner');",
      "apps/api/src/routes/mcp/dispatch-tool-params.ts:4:35 passes a legacy VM size into legacy VM-size authority: return capacity ?? getVcpuCount(params.vmSize, 'hetzner');",
    ]);
  });

  it('keeps every reviewed exception documented with a reason', () => {
    expect(REVIEWED_LEGACY_REQUEST_VALIDATORS.length).toBeGreaterThan(0);
    for (const entry of REVIEWED_LEGACY_REQUEST_VALIDATORS) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.owner).not.toBe('<module>');
    }
  });

  it('no longer honours a free-form neighbouring comment', () => {
    const findings = authorityFindings(
      file(
        'apps/api/src/services/node-selector.ts',
        [
          'export function select(node: { vmSize: string }, offers: Record<string, string>) {',
          '  // node-pool-boundary: historical display',
          '  const selected = offers[node.vmSize];',
          '  return selected;',
          '}',
        ].join('\n')
      )
    );

    expect(findings).toEqual([
      'apps/api/src/services/node-selector.ts:3:27 uses a legacy VM size as a catalog/capacity lookup key: const selected = offers[node.vmSize];',
    ]);
  });

  it('exempts named compatibility modules', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/legacy-node-pool-compatibility.ts',
          [
            "import { canSatisfyVmSize } from '@simple-agent-manager/shared';",
            'export function matches(node: string, want: string) { return canSatisfyVmSize(node, want); }',
          ].join('\n')
        )
      )
    ).toEqual([]);
  });
});

describe('node-pool allocation writers: detection', () => {
  it('resolves a renamed drizzle table binding', () => {
    expect(
      writerShapes([
        file(
          'apps/api/src/services/nodes.ts',
          [
            "import { nodes as hosts } from '../db/schema';",
            'export async function write(db: Db) { await db.insert(hosts).values({}); }',
          ].join('\n')
        ),
      ])
    ).toEqual([
      {
        filePath: 'apps/api/src/services/nodes.ts',
        table: 'nodes',
        writerKind: 'drizzle-insert',
        owner: 'write',
      },
    ]);
  });

  it('resolves a table binding aliased through a local variable', () => {
    expect(
      writerShapes([
        file(
          'apps/api/src/services/nodes.ts',
          [
            "import * as schema from '../db/schema';",
            'const hosts = schema.nodes;',
            'export async function write(db: Db) { await db.insert(hosts).values({}); }',
          ].join('\n')
        ),
      ])
    ).toEqual([
      {
        filePath: 'apps/api/src/services/nodes.ts',
        table: 'nodes',
        writerKind: 'drizzle-insert',
        owner: 'write',
      },
    ]);
  });

  it.each([
    ['quoted table name', 'INSERT INTO "nodes" (id) VALUES (?)'],
    ['bracketed table name', 'INSERT INTO [nodes] (id) VALUES (?)'],
    ['conflict clause', 'INSERT OR IGNORE INTO nodes (id) VALUES (?)'],
    ['replace conflict clause', 'INSERT OR REPLACE INTO nodes (id) VALUES (?)'],
    ['replace statement', 'REPLACE INTO nodes (id) VALUES (?)'],
    ['multiline statement', 'INSERT\n  INTO\n  nodes (id)\n  VALUES (?)'],
  ])('detects %s at an execution boundary', (_label, statement) => {
    expect(
      writerShapes([
        file(
          'apps/api/src/services/nodes.ts',
          `export async function write(db: D1Database) { await db.prepare(${JSON.stringify(statement)}).run(); }`
        ),
      ])
    ).toEqual([
      {
        filePath: 'apps/api/src/services/nodes.ts',
        table: 'nodes',
        writerKind: 'sql-insert',
        owner: 'write',
      },
    ]);
  });

  it('detects a backtick-quoted, schema-qualified table name', () => {
    const statement = 'INSERT INTO main.`nodes` (id) VALUES (?)';
    expect(
      writerShapes([
        file(
          'apps/api/src/services/nodes.ts',
          `export async function write(db: D1Database) { await db.prepare(${JSON.stringify(statement)}).run(); }`
        ),
      ])
    ).toEqual([
      {
        filePath: 'apps/api/src/services/nodes.ts',
        table: 'nodes',
        writerKind: 'sql-insert',
        owner: 'write',
      },
    ]);
  });

  it('attributes an indirectly-declared statement to its executing call site', () => {
    expect(
      writerShapes([
        file(
          'apps/api/src/services/nodes.ts',
          [
            "const STATEMENT = 'INSERT INTO nodes (id) VALUES (?)';",
            'export async function write(db: D1Database) { await db.prepare(STATEMENT).run(); }',
          ].join('\n')
        ),
      ])
    ).toEqual([
      {
        filePath: 'apps/api/src/services/nodes.ts',
        table: 'nodes',
        writerKind: 'sql-insert',
        owner: 'write',
      },
    ]);
  });

  it('does not treat SQL-shaped text that never executes as a writer', () => {
    expect(
      writerShapes([
        file(
          'apps/api/src/services/nodes.ts',
          "export function report() { console.error('INSERT INTO nodes failed'); }\n"
        ),
      ])
    ).toEqual([]);
  });

  it('respects table-name word boundaries', () => {
    expect(sqlInsertTables('INSERT INTO nodes_history (id) VALUES (?)')).toEqual([]);
    expect(sqlInsertTables('INSERT INTO archived_nodes (id) VALUES (?)')).toEqual([]);
    expect(sqlInsertTables('INSERT INTO nodes (id) VALUES (?)')).toEqual(['nodes']);
  });
});

describe('node-pool allocation writers: ownership and AST evidence', () => {
  const inventory: AllocationWriterInventoryEntry[] = [
    {
      filePath: 'apps/api/src/routes/tasks/submit.ts',
      table: 'tasks',
      owner: 'submitTask',
      role: 'user task submit route adapter',
      requiredEvidence: [
        { kind: 'anyCall', names: ['resolveTaskStartPlacement'], scope: 'module' },
        { kind: 'call', name: 'startTaskRunnerDO', scope: 'module' },
      ],
    },
  ];

  it('rejects evidence that exists only in a comment', () => {
    const findings = formatBoundaryViolations(
      validateAllocationWriterInventory(
        [
          file(
            'apps/api/src/routes/tasks/submit.ts',
            [
              "import * as schema from '../../db/schema';",
              '// resolveTaskStartPlacement startTaskRunnerDO',
              'export async function submitTask(db: Db, row: Record<string, unknown>) {',
              '  await db.insert(schema.tasks).values(row);',
              '}',
            ].join('\n')
          ),
        ],
        inventory
      )
    );

    expect(findings).toEqual([
      'apps/api/src/routes/tasks/submit.ts:4:9 tasks writer role "user task submit route adapter" is missing required evidence in "submitTask": a call to one of resolveTaskStartPlacement(): await db.insert(schema.tasks).values(row);',
      'apps/api/src/routes/tasks/submit.ts:4:9 tasks writer role "user task submit route adapter" is missing required evidence in "submitTask": call to startTaskRunnerDO(): await db.insert(schema.tasks).values(row);',
    ]);
  });

  it('rejects evidence that exists only as an unused import', () => {
    const findings = formatBoundaryViolations(
      validateAllocationWriterInventory(
        [
          file(
            'apps/api/src/routes/tasks/submit.ts',
            [
              "import * as schema from '../../db/schema';",
              "import { resolveTaskStartPlacement } from '../../services/placement-resolver';",
              "import { startTaskRunnerDO } from '../../services/task-runner-do';",
              'export async function submitTask(db: Db, row: Record<string, unknown>) {',
              '  await db.insert(schema.tasks).values(row);',
              '}',
            ].join('\n')
          ),
        ],
        inventory
      )
    );

    expect(findings).toEqual([
      'apps/api/src/routes/tasks/submit.ts:5:9 tasks writer role "user task submit route adapter" is missing required evidence in "submitTask": a call to one of resolveTaskStartPlacement(): await db.insert(schema.tasks).values(row);',
      'apps/api/src/routes/tasks/submit.ts:5:9 tasks writer role "user task submit route adapter" is missing required evidence in "submitTask": call to startTaskRunnerDO(): await db.insert(schema.tasks).values(row);',
    ]);
  });

  it('accepts real calls to the canonical service', () => {
    expect(
      validateAllocationWriterInventory(
        [
          file(
            'apps/api/src/routes/tasks/submit.ts',
            [
              "import * as schema from '../../db/schema';",
              'export async function submitTask(db: Db, row: Record<string, unknown>) {',
              '  const placement = resolveTaskStartPlacement(row);',
              '  await db.insert(schema.tasks).values({ ...row, placement });',
              '  await startTaskRunnerDO(row);',
              '}',
            ].join('\n')
          ),
        ],
        inventory
      )
    ).toEqual([]);
  });

  it('flags a second, unowned writer inside an already inventoried file and table', () => {
    const findings = formatBoundaryViolations(
      validateAllocationWriterInventory(
        [
          file(
            'apps/api/src/routes/tasks/submit.ts',
            [
              "import * as schema from '../../db/schema';",
              'export async function submitTask(db: Db, row: Record<string, unknown>) {',
              '  const placement = resolveTaskStartPlacement(row);',
              '  await db.insert(schema.tasks).values({ ...row, placement });',
              '  await startTaskRunnerDO(row);',
              '}',
              'export async function submitTaskQuietly(db: Db, row: Record<string, unknown>) {',
              '  await db.insert(schema.tasks).values(row);',
              '}',
            ].join('\n')
          ),
        ],
        inventory
      )
    );

    expect(findings).toEqual([
      'apps/api/src/routes/tasks/submit.ts:8:9 unowned tasks drizzle-insert in "submitTaskQuietly"; the inventory owns a different function in this file, so this writer bypasses the reviewed one: await db.insert(schema.tasks).values(row);',
    ]);
  });

  it('flags a writer in a file the inventory does not cover at all', () => {
    const findings = formatBoundaryViolations(
      validateAllocationWriterInventory(
        [
          file(
            'apps/api/src/services/unowned-allocation.ts',
            [
              "import * as schema from '../db/schema';",
              'export async function createTaskDirectly(db: Db) {',
              "  await db.insert(schema.tasks).values({ id: 'task-1' });",
              '}',
            ].join('\n')
          ),
        ],
        []
      )
    );

    expect(findings).toEqual([
      'apps/api/src/services/unowned-allocation.ts:3:9 unexpected tasks drizzle-insert in "createTaskDirectly"; add a narrow inventory role or route through a canonical service: await db.insert(schema.tasks).values({ id: \'task-1\' });',
    ]);
  });

  it('flags an inventory entry whose writer disappeared', () => {
    const findings = formatBoundaryViolations(
      validateAllocationWriterInventory(
        [file('apps/api/src/routes/tasks/submit.ts', 'export const noop = 1;\n')],
        inventory
      )
    );

    expect(findings).toEqual([
      'apps/api/src/routes/tasks/submit.ts:1:1 inventory entry for tasks writer "submitTask" is missing from source: user task submit route adapter',
    ]);
  });
});

describe('node-pool allocation entrypoints: provisioning beyond INSERT', () => {
  const inventory: AllocationEntrypointInventoryEntry[] = [
    {
      filePath: 'apps/api/src/durable-objects/task-runner/node-steps.ts',
      owner: 'handleNodeProvisioning',
      entrypoint: 'createNodeRecord',
      scope: 'task-runner',
      role: 'workspace',
      admission: 'admission lease revalidated at the allocation boundary',
      status: 'canonical',
      requiredEvidence: [{ kind: 'call', name: 'assertVmProvisioningLease' }],
    },
  ];

  it('detects the provisioning entrypoints the writer scan cannot see', () => {
    const callsites = scanAllocationEntrypoints([
      file(
        'apps/api/src/routes/nodes.ts',
        [
          'export async function createNode(env: Env) {',
          '  const created = await createNodeRecord(env, {});',
          '  await provisionNode(created.id, env);',
          '}',
        ].join('\n')
      ),
    ]).map(({ entrypoint, owner }) => ({ entrypoint, owner }));

    expect(callsites).toEqual([
      { entrypoint: 'createNodeRecord', owner: 'createNode' },
      { entrypoint: 'provisionNode', owner: 'createNode' },
    ]);
  });

  it('resolves an aliased import of a shared allocation service', () => {
    const callsites = scanAllocationEntrypoints([
      file(
        'apps/api/src/services/new-warmer.ts',
        [
          "import { createNodeRecord as allocate } from './nodes';",
          'export async function bypass(env: Env, input: Input) {',
          '  await allocate(env, input);',
          '}',
        ].join('\n')
      ),
    ]).map(({ entrypoint, owner }) => ({ entrypoint, owner }));

    expect(callsites).toEqual([{ entrypoint: 'createNodeRecord', owner: 'bypass' }]);
  });

  it('detects a direct provider allocation call', () => {
    const callsites = scanAllocationEntrypoints([
      file(
        'apps/api/src/services/rogue-provisioner.ts',
        'export async function go(provider: Provider, config: VMConfig) {\n  return provider.createVM(config);\n}\n'
      ),
    ]).map(({ entrypoint, owner }) => ({ entrypoint, owner }));

    expect(callsites).toEqual([{ entrypoint: 'createVM', owner: 'go' }]);
  });

  it('does not let a same-named local function suppress a different symbol', () => {
    const callsites = scanAllocationEntrypoints([
      file(
        'apps/api/src/services/shadow.ts',
        'export async function provisionNode(id: string, env: Env) {\n  return other.provisionNode(id, env);\n}\n'
      ),
    ]).map(({ entrypoint, owner }) => ({ entrypoint, owner }));

    expect(callsites).toEqual([{ entrypoint: 'provisionNode', owner: 'provisionNode' }]);
  });

  it('still exempts genuine self-recursion of a declared symbol', () => {
    expect(
      scanAllocationEntrypoints([
        file(
          'apps/api/src/services/nodes.ts',
          [
            'export async function provisionNode(id: string, env: Env): Promise<void> {',
            '  if (!id) return;',
            '  return provisionNode(id, env);',
            '}',
          ].join('\n')
        ),
      ])
    ).toEqual([]);
  });

  it('does not treat the shared service definition as its own entrypoint', () => {
    expect(
      scanAllocationEntrypoints([
        file(
          'apps/api/src/services/nodes.ts',
          [
            'export async function createNodeRecord(env: Env) {',
            '  return createNodeRecord;',
            '}',
          ].join('\n')
        ),
      ])
    ).toEqual([]);
  });

  it('flags a NEW caller of the shared service so createNodeRecord cannot conceal a bypass', () => {
    const findings = formatBoundaryViolations(
      validateAllocationEntrypointInventory(
        [
          file(
            'apps/api/src/services/new-fleet-warmer.ts',
            [
              'export async function warmFleet(env: Env) {',
              '  const node = await createNodeRecord(env, {});',
              '  await provisionNode(node.id, env);',
              '}',
            ].join('\n')
          ),
        ],
        inventory
      )
    );

    expect(findings).toEqual([
      'apps/api/src/services/new-fleet-warmer.ts:2:22 uninventoried allocation entrypoint createNodeRecord() in "warmFleet"; declare its scope, role and admission contract: const node = await createNodeRecord(env, {});',
      'apps/api/src/services/new-fleet-warmer.ts:3:9 uninventoried allocation entrypoint provisionNode() in "warmFleet"; declare its scope, role and admission contract: await provisionNode(node.id, env);',
      'apps/api/src/durable-objects/task-runner/node-steps.ts:1:1 inventory entry for allocation entrypoint createNodeRecord() in "handleNodeProvisioning" is missing from source: admission lease revalidated at the allocation boundary',
    ]);
  });

  it('accepts a canonical entrypoint whose admission evidence is present', () => {
    expect(
      validateAllocationEntrypointInventory(
        [
          file(
            'apps/api/src/durable-objects/task-runner/node-steps.ts',
            [
              'export async function handleNodeProvisioning(rc: RunContext) {',
              '  await assertVmProvisioningLease(rc.env);',
              '  await createNodeRecord(rc.env, {});',
              '}',
            ].join('\n')
          ),
        ],
        inventory
      )
    ).toEqual([]);
  });

  it('reports an entrypoint classified as an unreviewed bypass', () => {
    const findings = formatBoundaryViolations(
      validateAllocationEntrypointInventory(
        [
          file(
            'apps/api/src/routes/nodes.ts',
            'export async function createNode(env: Env) {\n  await createNodeRecord(env, {});\n}\n'
          ),
        ],
        [
          {
            filePath: 'apps/api/src/routes/nodes.ts',
            owner: 'createNode',
            entrypoint: 'createNodeRecord',
            scope: 'route',
            role: 'workspace',
            admission: 'credential + quota only; no capacity-pool admission',
            status: 'unreviewed-bypass',
          },
        ]
      )
    );

    expect(findings).toEqual([
      'apps/api/src/routes/nodes.ts:2:9 createNodeRecord() in "createNode" bypasses shared node-pool admission: credential + quota only; no capacity-pool admission: await createNodeRecord(env, {});',
    ]);
  });
});

describe('node-pool legacy authority: native SKU and accounting sinks', () => {
  it('flags a legacy size written into a provider-native instance type', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/nodes.ts',
          [
            'export async function go(provider: Provider, node: { vmSize: string }) {',
            '  return provider.createVM({ instanceType: node.vmSize });',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([
      'apps/api/src/services/nodes.ts:2:44 writes a legacy VM size into a provider-native SKU or resource/accounting field: return provider.createVM({ instanceType: node.vmSize });',
    ]);
  });

  it('flags a legacy size written into a billable resource count', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/compute-usage.ts',
          [
            'export async function track(db: Db, node: { vmSize: string }) {',
            '  await db.insert(schema.computeUsage).values({ vcpuCount: node.vmSize });',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([
      'apps/api/src/services/compute-usage.ts:2:60 writes a legacy VM size into a provider-native SKU or resource/accounting field: await db.insert(schema.computeUsage).values({ vcpuCount: node.vmSize });',
    ]);
  });

  it('flags a native field assigned outside an object literal', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/nodes.ts',
          [
            'export function adapt(config: { providerInstanceType: string }, node: { vmSize: string }) {',
            '  config.providerInstanceType = node.vmSize;',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([
      'apps/api/src/services/nodes.ts:2:33 writes a legacy VM size into a provider-native SKU or resource/accounting field: config.providerInstanceType = node.vmSize;',
    ]);
  });

  it('still allows the deprecated-size audit property', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/compute-usage.ts',
          'export function audit(node: { vmSize: string }) {\n  return { deprecatedSize: node.vmSize };\n}\n'
        )
      )
    ).toEqual([]);
  });

  it('still allows the pre-existing persisted serverType column', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/compute-usage.ts',
          [
            'export async function track(db: Db, input: { vmSize: string }) {',
            '  await db.insert(schema.computeUsage).values({ serverType: input.vmSize });',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([]);
  });
});

describe('node-pool legacy authority: namespace constants and computed fields', () => {
  it('flags a namespace-qualified legacy capacity table', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/node-selector.ts',
          [
            "import * as sizes from '@simple-agent-manager/shared';",
            'export function capacity(provider: string, size: string) {',
            '  return sizes.PROVIDER_VM_CAPACITY[provider][size];',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([
      'apps/api/src/services/node-selector.ts:3:10 reads legacy VM-size authority table PROVIDER_VM_CAPACITY: return sizes.PROVIDER_VM_CAPACITY[provider][size];',
    ]);
  });

  it('flags a bare reference to a legacy capacity table without calling it', () => {
    const findings = authorityFindings(
      file(
        'apps/api/src/services/node-selector.ts',
        [
          "import { PROVIDER_VM_CAPACITY } from '@simple-agent-manager/shared';",
          'export const table = PROVIDER_VM_CAPACITY;',
        ].join('\n')
      )
    );

    expect(findings).toEqual([
      "apps/api/src/services/node-selector.ts:1:10 imports legacy VM-size authority PROVIDER_VM_CAPACITY: import { PROVIDER_VM_CAPACITY } from '@simple-agent-manager/shared';",
      'apps/api/src/services/node-selector.ts:2:22 reads legacy VM-size authority table PROVIDER_VM_CAPACITY: export const table = PROVIDER_VM_CAPACITY;',
    ]);
  });

  it('resolves a statically computed legacy field name', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/node-selector.ts',
          [
            'export function pick(node: Record<string, string>, offers: Record<string, number>) {',
            "  const key = 'vm' + 'Size';",
            '  const selected = offers[node[key]];',
            '  return selected;',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([
      'apps/api/src/services/node-selector.ts:3:27 uses a legacy VM size as a catalog/capacity lookup key: const selected = offers[node[key]];',
    ]);
  });

  it('does not invent a field name it cannot statically resolve', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/node-selector.ts',
          [
            'export function pick(node: Record<string, string>, offers: Record<string, number>, key: string) {',
            '  return offers[node[key]];',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([]);
  });
});

describe('node-pool legacy authority: alias bindings are lexical', () => {
  it('does not leak a legacy alias into an unrelated function', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/node-selector.ts',
          [
            'export function historical(node: { vmSize: string }) {',
            '  const { vmSize: size } = node;',
            '  return { deprecatedSize: size };',
            '}',
            'export function native(size: string) {',
            '  return offers[size];',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([]);
  });

  it('still tracks the alias inside the function that bound it', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/node-selector.ts',
          [
            'export function pick(node: { vmSize: string }, offers: Record<string, number>) {',
            '  const { vmSize: size } = node;',
            '  return offers[size];',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([
      'apps/api/src/services/node-selector.ts:3:17 uses a legacy VM size as a catalog/capacity lookup key: return offers[size];',
    ]);
  });

  it('lets an inner parameter shadow an outer legacy alias', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/node-selector.ts',
          [
            'export function outer(node: { vmSize: string }, offers: Record<string, number>) {',
            '  const { vmSize: size } = node;',
            '  const inner = (size: string) => offers[size];',
            "  return inner('medium');",
            '}',
          ].join('\n')
        )
      )
    ).toEqual([]);
  });

  it('does not treat a container of legacy sizes as a legacy size', () => {
    expect(
      authorityFindings(
        file(
          'apps/api/src/services/placement-resolver.ts',
          [
            'export function collect(explicit: { vmSize?: string; vmSizeSource?: string }) {',
            '  const legacyVmSizes: Record<string, string> = {};',
            '  if (explicit.vmSize) {',
            "    legacyVmSizes[explicit.vmSizeSource ?? 'task'] = explicit.vmSize;",
            '  }',
            '  if (Object.keys(legacyVmSizes).length === 0) return null;',
            '  return legacyVmSizes;',
            '}',
          ].join('\n')
        )
      )
    ).toEqual([]);
  });
});

describe('node-pool inventories', () => {
  it('records every allocation writer with an owning function and a role', () => {
    for (const entry of ALLOCATION_WRITER_INVENTORY) {
      expect(entry.owner.length).toBeGreaterThan(0);
      expect(entry.role.length).toBeGreaterThan(0);
    }
    expect(ALLOCATION_WRITER_INVENTORY.length).toBeGreaterThanOrEqual(24);
  });

  it('records every allocation entrypoint with a scope, role and admission contract', () => {
    for (const entry of ALLOCATION_ENTRYPOINT_INVENTORY) {
      expect(entry.owner.length).toBeGreaterThan(0);
      expect(entry.admission.length).toBeGreaterThan(20);
    }
    expect(ALLOCATION_ENTRYPOINT_INVENTORY.length).toBeGreaterThanOrEqual(22);
  });

  it('has no duplicate writer or entrypoint ownership keys', () => {
    const writerKeys = ALLOCATION_WRITER_INVENTORY.map(
      (entry) => `${entry.filePath}|${entry.table}|${entry.owner}`
    );
    expect(new Set(writerKeys).size).toBe(writerKeys.length);

    const entrypointKeys = ALLOCATION_ENTRYPOINT_INVENTORY.map(
      (entry) => `${entry.filePath}|${entry.owner}|${entry.entrypoint}`
    );
    expect(new Set(entrypointKeys).size).toBe(entrypointKeys.length);
  });

  it(
    'keeps every inventoried writer and entrypoint present in the current source',
    { timeout: 120_000 },
    () => {
      const missing = formatBoundaryViolations(
        scanRepositoryNodePoolBoundary().filter((violation) =>
          violation.reason.startsWith('inventory entry for')
        )
      );
      expect(missing).toEqual([]);
    }
  );
});

describe('node-pool boundary gate: current repository state', () => {
  /**
   * The application migration is still in progress, so this documents the
   * current honest violation count rather than asserting zero. It must go DOWN
   * as the migration lands; it must never be raised to accommodate a new leak.
   */
  const MAX_KNOWN_VIOLATIONS = 60;

  it(
    'does not regress past the recorded node-pool boundary violation count',
    { timeout: 120_000 },
    () => {
      const violations = scanRepositoryNodePoolBoundary();
      const formatted = formatBoundaryViolations(violations);
      expect(formatted.length, formatted.join('\n')).toBeLessThanOrEqual(MAX_KNOWN_VIOLATIONS);
    }
  );

  it(
    'still reports the known legacy capacity-helper and size-ranking leaks',
    { timeout: 120_000 },
    () => {
      const formatted = formatBoundaryViolations(scanRepositoryNodePoolBoundary());
      expect(
        formatted.some(
          (line) =>
            line.includes('apps/api/src/services/node-selector.ts') &&
            line.includes('canSatisfyVmSize')
        )
      ).toBe(true);
      expect(
        formatted.some(
          (line) =>
            line.includes('apps/api/src/services/compute-usage.ts') && line.includes('getVcpuCount')
        )
      ).toBe(true);
      expect(formatted.some((line) => line.includes('bypasses shared node-pool admission'))).toBe(
        true
      );
    }
  );
});
