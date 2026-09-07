import ts from 'typescript';

import { type AllocationEntrypointCall, scanAllocationEntrypoints } from './allocation-entrypoints';
import { type AllocationTable, scanAllocationWriters } from './allocation-writers';
import { describeEvidence, type EvidenceRequirement, hasEvidence } from './evidence';
import { ALLOCATION_ENTRYPOINT_INVENTORY, ALLOCATION_WRITER_INVENTORY } from './inventory-data';
import {
  type BoundaryViolation,
  enclosingFunctionBody,
  enclosingFunctionName,
  parseSourceFile,
  type SourceFileInput,
} from './source-files';

export interface AllocationWriterInventoryEntry {
  filePath: string;
  table: AllocationTable;
  /** Enclosing function name; ownership is per callsite, not per file. */
  owner: string;
  role: string;
  canonicalService?: string;
  requiredEvidence?: EvidenceRequirement[];
}

/**
 * How a callsite is allowed to allocate. `unreviewed-bypass` is an honest
 * classification of current WIP application code, NOT an approval: it is
 * reported as a violation so the gate keeps failing until the callsite either
 * routes through shared admission or is deliberately re-classified.
 */
export type AllocationEntrypointStatus =
  | 'canonical'
  | 'role-adapter'
  | 'runtime-adapter'
  | 'runtime-dispatch'
  | 'unreviewed-bypass';

export interface AllocationEntrypointInventoryEntry {
  filePath: string;
  owner: string;
  entrypoint: AllocationEntrypointCall;
  /** Which control plane drives this callsite. */
  scope: 'task-runner' | 'route' | 'service' | 'trial-orchestrator';
  /** What the allocated capacity is for. */
  role: 'workspace' | 'deployment' | 'trial' | 'recovery-relay' | 'instant' | 'metering';
  /** The admission/authorization actually observed at this callsite. */
  admission: string;
  status: AllocationEntrypointStatus;
  requiredEvidence?: EvidenceRequirement[];
}

/**
 * The canonical task-start path is two module-level steps: resolve the placement
 * (through `resolveTaskStartPlacement` or one of its credential-attribution
 * variants) and hand the task to the TaskRunner DO. They legitimately sit in
 * sibling functions, so the evidence is module-scoped; per-callsite ownership is
 * enforced separately by the writer owner match.
 */
export function validateAllocationWriterInventory(
  files: readonly SourceFileInput[],
  inventory: readonly AllocationWriterInventoryEntry[] = ALLOCATION_WRITER_INVENTORY
): BoundaryViolation[] {
  const writers = scanAllocationWriters(files);
  const violations: BoundaryViolation[] = [];

  for (const writer of writers) {
    const entry = inventory.find(
      (candidate) =>
        candidate.filePath === writer.filePath &&
        candidate.table === writer.table &&
        candidate.owner === writer.owner
    );
    if (entry) continue;
    const fileIsInventoried = inventory.some(
      (candidate) => candidate.filePath === writer.filePath && candidate.table === writer.table
    );
    violations.push({
      kind: 'allocation-writer',
      filePath: writer.filePath,
      line: writer.line,
      column: writer.column,
      reason: fileIsInventoried
        ? `unowned ${writer.table} ${writer.writerKind} in "${writer.owner}"; the inventory owns a different function in this file, so this writer bypasses the reviewed one`
        : `unexpected ${writer.table} ${writer.writerKind} in "${writer.owner}"; add a narrow inventory role or route through a canonical service`,
      snippet: writer.snippet,
    });
  }

  for (const entry of inventory) {
    const writer = writers.find(
      (candidate) =>
        candidate.filePath === entry.filePath &&
        candidate.table === entry.table &&
        candidate.owner === entry.owner
    );
    if (!writer) {
      violations.push({
        kind: 'allocation-writer',
        filePath: entry.filePath,
        line: 1,
        column: 1,
        reason: `inventory entry for ${entry.table} writer "${entry.owner}" is missing from source`,
        snippet: entry.role,
      });
      continue;
    }
    violations.push(
      ...missingEvidenceViolations(
        files,
        entry.requiredEvidence,
        writer,
        (evidence) =>
          `${entry.table} writer role "${entry.role}" is missing required evidence in "${entry.owner}": ${evidence}`
      )
    );
  }

  return violations;
}

export function validateAllocationEntrypointInventory(
  files: readonly SourceFileInput[],
  inventory: readonly AllocationEntrypointInventoryEntry[] = ALLOCATION_ENTRYPOINT_INVENTORY
): BoundaryViolation[] {
  const callsites = scanAllocationEntrypoints(files);
  const violations: BoundaryViolation[] = [];

  for (const callsite of callsites) {
    const entry = inventory.find(
      (candidate) =>
        candidate.filePath === callsite.filePath &&
        candidate.owner === callsite.owner &&
        candidate.entrypoint === callsite.entrypoint
    );
    if (!entry) {
      violations.push({
        kind: 'allocation-entrypoint',
        filePath: callsite.filePath,
        line: callsite.line,
        column: callsite.column,
        reason: `uninventoried allocation entrypoint ${callsite.entrypoint}() in "${callsite.owner}"; declare its scope, role and admission contract`,
        snippet: callsite.snippet,
      });
      continue;
    }
    if (entry.status === 'unreviewed-bypass') {
      violations.push({
        kind: 'allocation-entrypoint',
        filePath: callsite.filePath,
        line: callsite.line,
        column: callsite.column,
        reason: `${callsite.entrypoint}() in "${callsite.owner}" bypasses shared node-pool admission: ${entry.admission}`,
        snippet: callsite.snippet,
      });
    }
    violations.push(
      ...missingEvidenceViolations(
        files,
        entry.requiredEvidence,
        callsite,
        (evidence) =>
          `${callsite.entrypoint}() in "${callsite.owner}" is missing required evidence: ${evidence}`
      )
    );
  }

  for (const entry of inventory) {
    const callsite = callsites.find(
      (candidate) =>
        candidate.filePath === entry.filePath &&
        candidate.owner === entry.owner &&
        candidate.entrypoint === entry.entrypoint
    );
    if (!callsite) {
      violations.push({
        kind: 'allocation-entrypoint',
        filePath: entry.filePath,
        line: 1,
        column: 1,
        reason: `inventory entry for allocation entrypoint ${entry.entrypoint}() in "${entry.owner}" is missing from source`,
        snippet: entry.admission,
      });
    }
  }

  return violations;
}

function missingEvidenceViolations(
  files: readonly SourceFileInput[],
  required: readonly EvidenceRequirement[] | undefined,
  site: { filePath: string; line: number; column: number; snippet: string },
  reason: (evidence: string) => string
): BoundaryViolation[] {
  if (!required || required.length === 0) return [];
  const file = files.find((candidate) => candidate.filePath === site.filePath);
  if (!file) return [];
  const sourceFile = parseSourceFile(file);
  const scope = ownerScope(sourceFile, site.line, site.column);
  return required
    .filter((requirement) => !hasEvidence(sourceFile, scope, requirement))
    .map((requirement) => ({
      kind: 'allocation-writer' as const,
      filePath: site.filePath,
      line: site.line,
      column: site.column,
      reason: reason(describeEvidence(requirement)),
      snippet: site.snippet,
    }));
}

/** The function body containing the recorded writer/entrypoint position. */
function ownerScope(sourceFile: ts.SourceFile, line: number, column: number): ts.Node | null {
  const position = sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1);
  let scope: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (node.getStart(sourceFile) <= position && position < node.getEnd()) {
      const body = enclosingFunctionBody(node);
      if (body && enclosingFunctionName(node) !== '<module>') scope = body;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sourceFile, visit);
  return scope;
}

export { ALLOCATION_ENTRYPOINT_INVENTORY, ALLOCATION_WRITER_INVENTORY };
