import { pathStartsWithAny } from './source-files';

/**
 * Legacy VM-tier authority symbols. Importing, re-exporting, aliasing or calling
 * any of these outside a named compatibility module means legacy tiers are still
 * deciding capacity, eligibility or metering.
 *
 * `legacyReusableNodeMatches` is deliberately absent: it is the sanctioned export
 * of `services/legacy-node-pool-compatibility.ts`, i.e. the one boundary legacy
 * reuse semantics are allowed to cross.
 */
export const LEGACY_AUTHORITY_SYMBOLS = new Set([
  'canSatisfyVmSize',
  'getVcpuCount',
  'PLATFORM_RESOURCE_DEFAULTS',
  'PROVIDER_VM_CAPACITY',
  'vmSizeFallbackChain',
  'VM_SIZE_ORDER',
]);

/**
 * Named compatibility modules. These OWN legacy semantics: they define the legacy
 * tier tables or translate legacy tiers at one reviewed boundary.
 */
export const COMPATIBILITY_MODULES = new Set([
  'apps/api/src/services/legacy-node-pool-compatibility.ts',
  'packages/shared/src/constants/vm-sizes.ts',
  'packages/shared/src/constants/resource-defaults.ts',
  'packages/providers/src/instance-offerings.ts',
  'packages/providers/src/native-vm-config.ts',
  'packages/providers/src/types.ts',
]);

/** Tier 2 (plain legacy reads) applies to canonical node-pool authority modules. */
const LEGACY_AUTHORITY_SCOPE_DIRECTORIES = [
  'apps/api/src/durable-objects/task-runner/',
  'apps/api/src/durable-objects/trial-orchestrator/',
  'packages/providers/src/',
] as const;

/**
 * Canonical family tokens. A module under a control-plane directory whose file
 * name carries one of these tokens is placement/provider/metering authority,
 * so a newly added `services/placement-ranking.ts` is in scope on creation.
 */
const LEGACY_AUTHORITY_FAMILY_ROOTS = [
  'apps/api/src/services/',
  'apps/api/src/durable-objects/',
  'apps/api/src/scheduled/',
  'packages/providers/src/',
] as const;

const LEGACY_AUTHORITY_FAMILY_TOKENS = new Set([
  'admission',
  'allocation',
  'capacity',
  'metering',
  'node',
  'nodes',
  'offering',
  'offerings',
  'placement',
  'pool',
  'pools',
  'provision',
  'provisioning',
  'ranking',
  'reservation',
  'scheduler',
  'selection',
  'selector',
  'usage',
]);

/** Explicitly classified modules that carry no family token. */
const LEGACY_AUTHORITY_CLASSIFIED_PATHS = new Set([
  'apps/api/src/services/runtime-allocation.ts',
  'apps/api/src/services/workspace-resource-capacity.ts',
  'apps/api/src/services/instant-session.ts',
]);

/**
 * Narrow, reviewed exceptions: functions that validate a DEPRECATED legacy-size
 * request field against the legacy vocabulary. Keeping the old API/MCP/CLI
 * fields accepting `small|medium|large` is a required compatibility contract, so
 * validating them is transport, not placement authority.
 *
 * The exception is scoped to comparison classifications only. A catalog lookup,
 * a legacy-authority call or a plain authority-scope read inside the same
 * function is still reported. Adding an entry requires editing this file, and
 * every entry is paired with a discriminating test.
 */
export interface ReviewedLegacyValidator {
  filePath: string;
  owner: string;
  reason: string;
}

export const REVIEWED_LEGACY_REQUEST_VALIDATORS: readonly ReviewedLegacyValidator[] = [
  {
    filePath: 'apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts',
    owner: 'dispatchTask',
    reason: 'validates the deprecated dispatch_task vmSize argument before translation',
  },
  {
    filePath: 'apps/api/src/routes/mcp/dispatch-tool-params.ts',
    owner: 'parseDispatchTaskParams',
    reason: 'validates the deprecated MCP dispatch vmSize parameter',
  },
  {
    filePath: 'apps/api/src/routes/mcp/trigger-create-tool.ts',
    owner: 'handleCreateTrigger',
    reason: 'validates the deprecated trigger vmSizeOverride parameter',
  },
  {
    filePath: 'apps/api/src/routes/mcp/trigger-tools.ts',
    owner: 'handleUpdateTrigger',
    reason: 'validates the deprecated trigger vmSizeOverride parameter',
  },
  {
    filePath: 'apps/api/src/routes/projects/crud.ts',
    owner: 'patch /:id',
    reason: 'validates the deprecated project defaultVmSize body field',
  },
] as const;

export type LegacyReadClassification =
  | 'authority-lookup'
  | 'authority-comparison'
  | 'authority-argument'
  | 'type-position'
  | 'persisted-transport'
  | 'legacy-propagation'
  | 'metadata-property'
  | 'adapter-guard'
  | 'adapter-validation'
  | 'plain-read';

export const AUTHORITY_CLASSIFICATIONS = new Set<LegacyReadClassification>([
  'authority-lookup',
  'authority-comparison',
  'authority-argument',
]);

export const CLASSIFICATION_REASON: Record<LegacyReadClassification, string> = {
  'authority-lookup': 'uses a legacy VM size as a catalog/capacity lookup key',
  'authority-comparison': 'compares a legacy VM size to decide eligibility or ranking',
  'authority-argument': 'passes a legacy VM size into legacy VM-size authority',
  'type-position': '',
  'persisted-transport': '',
  'legacy-propagation': '',
  'metadata-property': '',
  'adapter-guard': '',
  'adapter-validation': '',
  'plain-read': 'reads a legacy VM size in placement/provider/metering authority scope',
};

/** Legacy size property/identifier names, excluding `*Source` provenance labels. */
export function isLegacySizeName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('source') || lower.endsWith('sources')) return false;
  return (
    lower.includes('vmsize') ||
    lower.includes('vm_size') ||
    lower === 'machinesize' ||
    // `serverType` is deliberately absent: it names a persisted column and the
    // observed-hardware provenance record, not legacy VM-tier authority.
    lower === 'legacysize' ||
    lower === 'deprecatedsize'
  );
}

/**
 * A legacy field name written as a string literal. Must be a single identifier
 * token: a SQL statement that merely mentions `vm_size` is transport text, not a
 * legacy-size value expression.
 */
export function isLegacySizeFieldLiteral(text: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return false;
  return isLegacySizeName(text);
}

export function isCompatibilityModule(filePath: string): boolean {
  return COMPATIBILITY_MODULES.has(filePath);
}

export function isLegacyAuthorityScope(filePath: string): boolean {
  if (LEGACY_AUTHORITY_CLASSIFIED_PATHS.has(filePath)) return true;
  if (pathStartsWithAny(filePath, LEGACY_AUTHORITY_SCOPE_DIRECTORIES)) return true;
  if (!pathStartsWithAny(filePath, LEGACY_AUTHORITY_FAMILY_ROOTS)) return false;
  return fileNameTokens(filePath).some((token) => LEGACY_AUTHORITY_FAMILY_TOKENS.has(token));
}

export function isReviewedLegacyValidator(filePath: string, owner: string): boolean {
  return REVIEWED_LEGACY_REQUEST_VALIDATORS.some(
    (entry) => entry.filePath === filePath && entry.owner === owner
  );
}

function fileNameTokens(filePath: string): string[] {
  const base = filePath.split('/').pop() ?? filePath;
  return base
    .replace(/\.[cm]?tsx?$/, '')
    .split(/[-._]/)
    .filter(Boolean);
}
