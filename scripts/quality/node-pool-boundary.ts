/**
 * Node-pool legacy-compatibility boundary gate.
 *
 * Two enforced contracts:
 *  1. Legacy VM-tier authority (`getVcpuCount`, `canSatisfyVmSize`, legacy size
 *     values used as catalog keys / eligibility comparisons) may only live in a
 *     named compatibility module.
 *  2. Every allocation writer AND every allocation/provisioning entrypoint is
 *     inventoried per owning function with an explicit scope/role/admission
 *     contract, verified from the AST rather than from source text.
 *
 * Run with `pnpm quality:node-pool-boundary`.
 */
export {
  ALLOCATION_ENTRYPOINT_CALLS,
  type AllocationEntrypointCall,
  type AllocationEntrypointCallsite,
  scanAllocationEntrypoints,
} from './node-pool-boundary/allocation-entrypoints';
export {
  type AllocationTable,
  type AllocationWriter,
  type AllocationWriterKind,
  scanAllocationWriters,
  sqlInsertTables,
} from './node-pool-boundary/allocation-writers';
export { type EvidenceRequirement } from './node-pool-boundary/evidence';
export {
  ALLOCATION_ENTRYPOINT_INVENTORY,
  ALLOCATION_WRITER_INVENTORY,
  type AllocationEntrypointInventoryEntry,
  type AllocationEntrypointStatus,
  type AllocationWriterInventoryEntry,
  validateAllocationEntrypointInventory,
  validateAllocationWriterInventory,
} from './node-pool-boundary/inventory';
export { classifyLegacyRead, scanLegacyAuthority } from './node-pool-boundary/legacy-authority';
export {
  COMPATIBILITY_MODULES,
  isLegacyAuthorityScope,
  LEGACY_AUTHORITY_SYMBOLS,
  type LegacyReadClassification,
  REVIEWED_LEGACY_REQUEST_VALIDATORS,
} from './node-pool-boundary/legacy-authority-scope';
export {
  type BoundaryViolation,
  findRepoRoot,
  formatBoundaryViolations,
  listRepositorySourceFiles,
  type SourceFileInput,
} from './node-pool-boundary/source-files';

import {
  validateAllocationEntrypointInventory,
  validateAllocationWriterInventory,
} from './node-pool-boundary/inventory';
import { scanLegacyAuthority } from './node-pool-boundary/legacy-authority';
import {
  type BoundaryViolation,
  findRepoRoot,
  formatBoundaryViolations,
  listRepositorySourceFiles,
} from './node-pool-boundary/source-files';

export function scanRepositoryNodePoolBoundary(repoRoot = findRepoRoot()): BoundaryViolation[] {
  const files = listRepositorySourceFiles(repoRoot);
  return [
    ...scanLegacyAuthority(files),
    ...validateAllocationWriterInventory(files),
    ...validateAllocationEntrypointInventory(files),
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = scanRepositoryNodePoolBoundary();
  if (violations.length > 0) {
    console.error(formatBoundaryViolations(violations).join('\n'));
    console.error(`\n${violations.length} node-pool boundary violation(s).`);
    process.exit(1);
  }
}
