import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import ts from 'typescript';

export type AllocationTable = 'tasks' | 'nodes' | 'workspaces' | 'compute_usage';
export type AllocationWriterKind = 'drizzle-insert' | 'sql-insert';

export interface SourceFileInput {
  filePath: string;
  source: string;
}

export interface BoundaryViolation {
  kind: 'legacy-authority' | 'allocation-writer';
  filePath: string;
  line: number;
  column: number;
  reason: string;
  snippet: string;
}

export interface AllocationWriter {
  filePath: string;
  line: number;
  column: number;
  table: AllocationTable;
  writerKind: AllocationWriterKind;
  snippet: string;
}

export interface AllocationWriterInventoryEntry {
  filePath: string;
  table: AllocationTable;
  role: string;
  canonicalService?: string;
  requiredEvidence?: string[];
}

export const ALLOCATION_WRITER_INVENTORY: readonly AllocationWriterInventoryEntry[] = [
  {
    filePath: 'apps/api/src/routes/tasks/submit.ts',
    table: 'tasks',
    role: 'user task submit route adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: ['resolveTaskStartPlacement', 'startTaskRunnerDO'],
  },
  {
    filePath: 'apps/api/src/routes/mcp/dispatch-tool.ts',
    table: 'tasks',
    role: 'MCP dispatch route adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: ['resolveTaskStartPlacement', 'startTaskRunnerDO'],
  },
  {
    filePath: 'apps/api/src/routes/mcp/orchestration-tools.ts',
    table: 'tasks',
    role: 'MCP orchestration retry adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: ['resolveTaskStartPlacement', 'startTaskRunnerDO'],
  },
  {
    filePath: 'apps/api/src/services/trigger-submit.ts',
    table: 'tasks',
    role: 'trigger submission adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: ['resolveTaskStartPlacement', 'startTaskRunnerDO'],
  },
  {
    filePath: 'apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts',
    table: 'tasks',
    role: 'SAM session dispatch tool adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: ['resolveTaskStartPlacement', 'startTaskRunnerDO'],
  },
  {
    filePath: 'apps/api/src/durable-objects/sam-session/tools/retry-subtask.ts',
    table: 'tasks',
    role: 'SAM session subtask retry adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: ['resolveTaskStartPlacement', 'startTaskRunnerDO'],
  },
  {
    filePath: 'apps/api/src/services/session-recovery.ts',
    table: 'tasks',
    role: 'sleeping session wake recovery adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: ['resolveTaskStartPlacement', 'startTaskRunnerDO'],
  },
  {
    filePath: 'apps/api/src/routes/workspaces/crud.ts',
    table: 'tasks',
    role: 'legacy direct workspace conversation task adapter',
    canonicalService: 'explicit legacy workspace route adapter',
    requiredEvidence: ['createNodeRecord', 'provisionNode', 'startComputeTracking'],
  },
  {
    filePath: 'apps/api/src/routes/tasks/crud.ts',
    table: 'tasks',
    role: 'task metadata CRUD adapter',
    canonicalService: 'explicit non-running task creation adapter',
  },
  {
    filePath: 'apps/api/src/routes/chat.ts',
    table: 'tasks',
    role: 'conversation task compatibility adapter',
    canonicalService: 'explicit chat task adapter',
  },
  {
    filePath: 'apps/api/src/routes/chat-start.ts',
    table: 'tasks',
    role: 'conversation start compatibility adapter',
    canonicalService: 'explicit chat-start task adapter',
  },
  {
    filePath: 'apps/api/src/routes/mcp/idea-tools.ts',
    table: 'tasks',
    role: 'MCP idea task materialization adapter',
    canonicalService: 'explicit idea adapter',
  },
  {
    filePath: 'apps/api/src/durable-objects/sam-session/tools/create-idea.ts',
    table: 'tasks',
    role: 'SAM session idea task materialization adapter',
    canonicalService: 'explicit idea adapter',
  },
  {
    filePath: 'apps/api/src/services/debug-agent.ts',
    table: 'tasks',
    role: 'debug diagnosis task adapter',
    canonicalService: 'explicit diagnostic adapter',
  },
  {
    filePath: 'apps/api/src/services/platform-feedback-triage/runner.ts',
    table: 'tasks',
    role: 'platform feedback triage task adapter',
    canonicalService: 'explicit feedback adapter',
  },
  {
    filePath: 'apps/api/src/services/platform-feedback-incidents/user-report.ts',
    table: 'tasks',
    role: 'platform feedback incident task adapter',
    canonicalService: 'explicit feedback adapter',
  },
  {
    filePath: 'apps/api/src/services/trial/trial-runner.ts',
    table: 'tasks',
    role: 'trial orchestration task adapter',
    canonicalService: 'explicit trial runtime adapter',
  },
  {
    filePath: 'apps/api/src/services/session-task-repair.ts',
    table: 'tasks',
    role: 'session task repair adapter',
    canonicalService: 'explicit repair adapter',
  },
  {
    filePath: 'apps/api/src/services/nodes.ts',
    table: 'nodes',
    role: 'canonical node row writer',
    canonicalService: 'createNodeRecord',
    requiredEvidence: ['export async function createNodeRecord', 'capacityPlacementSnapshot'],
  },
  {
    filePath: 'apps/api/src/routes/workspaces/crud.ts',
    table: 'workspaces',
    role: 'legacy direct workspace route adapter',
    canonicalService: 'explicit legacy workspace route adapter',
    requiredEvidence: ['createNodeRecord', 'provisionNode', 'startComputeTracking'],
  },
  {
    filePath: 'apps/api/src/services/instant-session.ts',
    table: 'workspaces',
    role: 'Cloudflare container instant runtime adapter',
    canonicalService: 'explicit cf-container runtime adapter',
    requiredEvidence: ["runtime: 'cf-container'", "providerInstanceType: 'cf-container'"],
  },
  {
    filePath: 'apps/api/src/durable-objects/trial-orchestrator/steps.ts',
    table: 'workspaces',
    role: 'trial runtime workspace adapter',
    canonicalService: 'explicit trial runtime adapter',
    requiredEvidence: ['createWorkspaceOnNode', 'TRIAL_VM_SIZE'],
  },
  {
    filePath: 'apps/api/src/services/workspace-placement.ts',
    table: 'workspaces',
    role: 'canonical final workspace placement writer',
    canonicalService: 'reserveWorkspacePlacement',
    requiredEvidence: [
      'export async function reserveWorkspacePlacement',
      'resolved_reservation_json',
    ],
  },
  {
    filePath: 'apps/api/src/services/compute-usage.ts',
    table: 'compute_usage',
    role: 'canonical compute metering row writer',
    canonicalService: 'startComputeTracking',
    requiredEvidence: ['export async function startComputeTracking', 'providerInstanceVcpuCount'],
  },
] as const;

const LEGACY_AUTHORITY_IDENTIFIERS = new Set([
  'canSatisfyVmSize',
  'getVcpuCount',
  'PLATFORM_RESOURCE_DEFAULTS',
  'PROVIDER_VM_CAPACITY',
  'vmSizeFallbackChain',
]);

const LEGACY_AUTHORITY_SCOPE_PATHS = [
  'apps/api/src/services/placement-resolver.ts',
  'apps/api/src/services/placement-resolver-capacity.ts',
  'apps/api/src/services/workspace-placement.ts',
  'apps/api/src/services/workspace-resource-capacity.ts',
  'apps/api/src/services/nodes.ts',
  'apps/api/src/services/node-selector.ts',
  'apps/api/src/services/compute-usage.ts',
  'apps/api/src/services/node-usage.ts',
  'apps/api/src/services/deployment-provisioning.ts',
  'apps/api/src/services/runtime-allocation.ts',
  'apps/api/src/durable-objects/task-runner/',
  'packages/providers/src/',
] as const;

const LEGACY_AUTHORITY_ALLOWED_PATHS = new Set([
  'apps/api/src/services/legacy-node-pool-compatibility.ts',
  'packages/providers/src/instance-offerings.ts',
  'packages/providers/src/native-vm-config.ts',
  'packages/providers/src/types.ts',
]);

const SCANNED_SOURCE_ROOTS = [
  'apps/api/src',
  'packages/providers/src',
  'packages/shared/src',
] as const;

const ALLOCATION_WRITER_ROOTS = ['apps/api/src'] as const;

const TABLE_NAMES: Record<string, AllocationTable> = {
  tasks: 'tasks',
  nodes: 'nodes',
  workspaces: 'workspaces',
  computeUsage: 'compute_usage',
  compute_usage: 'compute_usage',
};

const RAW_SQL_TABLE_NAMES: Record<string, AllocationTable> = {
  tasks: 'tasks',
  nodes: 'nodes',
  workspaces: 'workspaces',
  compute_usage: 'compute_usage',
};

export function findRepoRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (current !== dirname(current)) {
    if (existsSync(join(current, '.git')) && existsSync(join(current, 'package.json'))) {
      return current;
    }
    current = dirname(current);
  }
  throw new Error(`Could not find repository root from ${start}`);
}

export function listRepositorySourceFiles(repoRoot = findRepoRoot()): SourceFileInput[] {
  const tracked = execFileSync('git', ['ls-files', ...SCANNED_SOURCE_ROOTS], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((filePath) => filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
    .filter((filePath) => !filePath.endsWith('.d.ts'));

  return tracked.map((filePath) => ({
    filePath,
    source: readFileSync(join(repoRoot, filePath), 'utf8'),
  }));
}

export function scanLegacyAuthority(files: readonly SourceFileInput[]): BoundaryViolation[] {
  return files
    .filter((file) => isLegacyAuthorityScope(file.filePath))
    .filter((file) => !LEGACY_AUTHORITY_ALLOWED_PATHS.has(file.filePath))
    .flatMap((file) => scanLegacyAuthorityFile(file));
}

export function scanAllocationWriters(files: readonly SourceFileInput[]): AllocationWriter[] {
  return files
    .filter((file) => pathStartsWithAny(file.filePath, ALLOCATION_WRITER_ROOTS))
    .flatMap((file) => scanAllocationWriterFile(file));
}

export function validateAllocationWriterInventory(
  files: readonly SourceFileInput[],
  inventory: readonly AllocationWriterInventoryEntry[] = ALLOCATION_WRITER_INVENTORY
): BoundaryViolation[] {
  const writers = scanAllocationWriters(files);
  const violations: BoundaryViolation[] = [];

  for (const writer of writers) {
    const matchingEntry = inventory.find(
      (entry) => entry.filePath === writer.filePath && entry.table === writer.table
    );
    if (!matchingEntry) {
      violations.push({
        kind: 'allocation-writer',
        filePath: writer.filePath,
        line: writer.line,
        column: writer.column,
        reason: `unexpected ${writer.table} ${writer.writerKind}; add a narrow inventory role or route through a canonical service`,
        snippet: writer.snippet,
      });
    }
  }

  for (const entry of inventory) {
    const matchingWriter = writers.find(
      (writer) => writer.filePath === entry.filePath && writer.table === entry.table
    );
    const sourceFile = files.find((file) => file.filePath === entry.filePath);
    if (!matchingWriter) {
      violations.push({
        kind: 'allocation-writer',
        filePath: entry.filePath,
        line: 1,
        column: 1,
        reason: `inventory entry for ${entry.table} writer is missing from source`,
        snippet: entry.role,
      });
      continue;
    }

    const missingEvidence = (entry.requiredEvidence ?? []).filter(
      (evidence) => !sourceFile?.source.includes(evidence)
    );
    for (const evidence of missingEvidence) {
      violations.push({
        kind: 'allocation-writer',
        filePath: entry.filePath,
        line: matchingWriter.line,
        column: matchingWriter.column,
        reason: `${entry.table} writer role "${entry.role}" is missing required evidence: ${evidence}`,
        snippet: matchingWriter.snippet,
      });
    }
  }

  return violations;
}

export function scanRepositoryNodePoolBoundary(repoRoot = findRepoRoot()): BoundaryViolation[] {
  const files = listRepositorySourceFiles(repoRoot);
  return [...scanLegacyAuthority(files), ...validateAllocationWriterInventory(files)];
}

export function formatBoundaryViolations(violations: readonly BoundaryViolation[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.filePath}:${violation.line}:${violation.column} ${violation.reason}: ${violation.snippet}`
  );
}

function scanLegacyAuthorityFile(file: SourceFileInput): BoundaryViolation[] {
  const sourceFile = ts.createSourceFile(file.filePath, file.source, ts.ScriptTarget.Latest, true);
  const violations: BoundaryViolation[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportSpecifier(node) && LEGACY_AUTHORITY_IDENTIFIERS.has(node.name.text)) {
      violations.push(
        toViolation(
          file,
          sourceFile,
          node.name,
          `imports legacy VM-size authority ${node.name.text}`
        )
      );
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      LEGACY_AUTHORITY_IDENTIFIERS.has(node.expression.text)
    ) {
      violations.push(
        toViolation(
          file,
          sourceFile,
          node.expression,
          `calls legacy VM-size authority ${node.expression.text}`
        )
      );
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'vmSize' &&
      !isAllowedHistoricalDisplay(file.source, sourceFile, node)
    ) {
      violations.push(
        toViolation(
          file,
          sourceFile,
          node.name,
          'reads legacy vmSize in placement/provider/metering authority scope'
        )
      );
    } else if (
      ts.isStringLiteralLike(node) &&
      (node.text === 'vm_size' || node.text === 'vmSize' || node.text === 'legacyVmSize') &&
      !isAllowedHistoricalDisplay(file.source, sourceFile, node)
    ) {
      violations.push(
        toViolation(
          file,
          sourceFile,
          node,
          `uses legacy size field "${node.text}" in placement/provider/metering authority scope`
        )
      );
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function scanAllocationWriterFile(file: SourceFileInput): AllocationWriter[] {
  const sourceFile = ts.createSourceFile(file.filePath, file.source, ts.ScriptTarget.Latest, true);
  const writers: AllocationWriter[] = [];

  function visit(node: ts.Node): void {
    const drizzleTable = getDrizzleInsertTable(node);
    if (drizzleTable) {
      writers.push(toWriter(file, sourceFile, node, drizzleTable, 'drizzle-insert'));
    }

    const sqlTable = getRawSqlInsertTable(node);
    if (sqlTable) {
      writers.push(toWriter(file, sourceFile, node, sqlTable, 'sql-insert'));
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return writers;
}

function getDrizzleInsertTable(node: ts.Node): AllocationTable | null {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  if (node.expression.name.text !== 'insert') return null;

  const [tableArg] = node.arguments;
  if (!tableArg) return null;
  if (ts.isPropertyAccessExpression(tableArg)) {
    return TABLE_NAMES[tableArg.name.text] ?? null;
  }
  if (ts.isIdentifier(tableArg)) {
    return TABLE_NAMES[tableArg.text] ?? null;
  }
  return null;
}

function getRawSqlInsertTable(node: ts.Node): AllocationTable | null {
  const text = getLiteralOrTemplateText(node);
  if (!text) return null;

  const normalized = text.replace(/\s+/g, ' ').toLowerCase();
  for (const [sqlName, table] of Object.entries(RAW_SQL_TABLE_NAMES)) {
    if (normalized.includes(`insert into ${sqlName}`)) return table;
  }
  return null;
}

function getLiteralOrTemplateText(node: ts.Node): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
  }
  return null;
}

function isLegacyAuthorityScope(filePath: string): boolean {
  return LEGACY_AUTHORITY_SCOPE_PATHS.some((scope) =>
    scope.endsWith('/') ? filePath.startsWith(scope) : filePath === scope
  );
}

function pathStartsWithAny(filePath: string, roots: readonly string[]): boolean {
  return roots.some((root) => filePath === root || filePath.startsWith(`${root}/`));
}

function isAllowedHistoricalDisplay(
  source: string,
  sourceFile: ts.SourceFile,
  node: ts.Node
): boolean {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const sourceLines = source.split('\n');
  const nearby = sourceLines
    .slice(Math.max(0, line - 2), line + 1)
    .join('\n')
    .toLowerCase();
  return (
    nearby.includes('node-pool-boundary: historical display') ||
    nearby.includes('node-pool-boundary: compatibility estimate')
  );
}

function toViolation(
  file: SourceFileInput,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  reason: string
): BoundaryViolation {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    kind: 'legacy-authority',
    filePath: file.filePath,
    line: line + 1,
    column: character + 1,
    reason,
    snippet: sourceLine(file.source, line),
  };
}

function toWriter(
  file: SourceFileInput,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  table: AllocationTable,
  writerKind: AllocationWriterKind
): AllocationWriter {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    filePath: file.filePath,
    line: line + 1,
    column: character + 1,
    table,
    writerKind,
    snippet: sourceLine(file.source, line),
  };
}

function sourceLine(source: string, zeroBasedLine: number): string {
  return source.split('\n')[zeroBasedLine]?.trim() ?? '';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = scanRepositoryNodePoolBoundary();
  if (violations.length > 0) {
    console.error(formatBoundaryViolations(violations).join('\n'));
    process.exit(1);
  }
}
