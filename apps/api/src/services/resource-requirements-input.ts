import {
  normalizeResourceRequirements,
  type ResolvedResourceReservation,
  RESOURCE_REQUIREMENT_FIELDS,
  type ResourceRequirementFieldProvenance,
  type ResourceRequirements,
  type ResourceRequirementsSource,
  type ResourceResolutionInput,
  type VMSize,
} from '@simple-agent-manager/shared';

const RESOURCE_LAYER_ORDER = [
  'task',
  'trigger',
  'skill',
  'agentProfile',
  'project',
  'user',
] as const;
type StoredResourceLayerName = (typeof RESOURCE_LAYER_ORDER)[number];

export const PERSISTED_TASK_RESOURCE_PLAN_VERSION = 1;

const SOURCE_TO_RESOURCE_LAYER: Partial<
  Record<ResourceRequirementsSource, StoredResourceLayerName>
> = {
  task: 'task',
  trigger: 'trigger',
  skill: 'skill',
  'agent-profile': 'agentProfile',
  project: 'project',
  user: 'user',
};

const RESOURCE_REQUIREMENTS_SOURCES = new Set<ResourceRequirementsSource>([
  'task',
  'trigger',
  'skill',
  'agent-profile',
  'project',
  'user',
  'platform',
]);

const LEGACY_VM_SIZES = new Set<VMSize>(['small', 'medium', 'large']);

interface ResourceRequirementLayerJsonInput {
  task?: string | null | undefined;
  trigger?: string | null | undefined;
  skill?: string | null | undefined;
  agentProfile?: string | null | undefined;
  project?: string | null | undefined;
  user?: string | null | undefined;
}

export interface PersistedTaskResourcePlanV1 {
  version: typeof PERSISTED_TASK_RESOURCE_PLAN_VERSION;
  intent: Record<StoredResourceLayerName, ResourceRequirements | null>;
  resolvedReservation: ResolvedResourceReservation;
  legacyVmSize?: {
    value: VMSize | null;
    source: ResourceRequirementsSource | null;
  };
}

export type PersistedTaskResourcePlan = PersistedTaskResourcePlanV1;

export interface PersistedTaskResourcePlanReadInput {
  taskId: string;
  triggerId?: string | null;
  skillId?: string | null;
  agentProfileId?: string | null;
  projectId: string;
  userId: string;
  resourceRequirementPlanJson?: string | null;
  resourceRequirementsJson?: string | null;
  resourceRequirementsSource?: string | null;
  resolvedReservationJson?: string | null;
  requestedVmSize?: string | null;
  requestedVmSizeSource?: string | null;
}

export interface PersistedTaskResourcePlanReadOptions {
  /**
   * Used by Run when an explicit modern replacement for the TASK layer has
   * already been supplied. It lets a caller repair malformed legacy task JSON
   * without silently accepting malformed stored data on omitted retry/run
   * requests.
   *
   * It suppresses ONLY the layer the explicit replacement actually replaces —
   * the stored `task` layer (and legacy rows whose source cannot be attributed
   * to any layer, which no inherited layer can claim). A legacy row whose
   * source is `trigger`/`skill`/`agent-profile`/`project`/`user` describes an
   * INHERITED requirement that a task-level override does not replace, so it is
   * still parsed strictly and preserved. Suppressing those erased valid
   * inherited requirements on every explicit Run object/null request.
   */
  ignoreLegacyResourceRequirementsJson?: boolean;
}

export interface PersistedTaskResourcePlanReadResult {
  layers: ResourceResolutionInput;
  resolvedReservation: ResolvedResourceReservation | null;
  requestedVmSize: VMSize | null;
  requestedVmSizeSource: ResourceRequirementsSource | null;
  source: 'plan-v1' | 'reservation-provenance' | 'legacy-source-json' | 'legacy-vm-size' | 'empty';
}

export class ResourceRequirementsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceRequirementsValidationError';
  }
}

export function normalizeResourceRequirementsInput(
  value: unknown,
  fieldName = 'resourceRequirements'
): ResourceRequirements {
  try {
    return normalizeResourceRequirements(value);
  } catch (err) {
    if (err instanceof Error) {
      throw new ResourceRequirementsValidationError(
        err.message.replace(/^resourceRequirements(?=\.| |$)/, fieldName)
      );
    }
    throw err;
  }
}

export function serializeResourceRequirementsInput(
  value: unknown,
  fieldName = 'resourceRequirements'
): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.stringify(normalizeResourceRequirementsInput(JSON.parse(trimmed), fieldName));
    } catch (err) {
      if (err instanceof ResourceRequirementsValidationError) throw err;
      throw new ResourceRequirementsValidationError(`${fieldName} must be a valid JSON object`);
    }
  }
  return JSON.stringify(normalizeResourceRequirementsInput(value, fieldName));
}

export function serializeModernResourceRequirementsInput(
  value: unknown,
  fieldName = 'resourceRequirements'
): string | null {
  if (value === null) return null;
  if (!isPlainObject(value)) {
    throw new ResourceRequirementsValidationError(`${fieldName} must be an object or null`);
  }
  return JSON.stringify(normalizeResourceRequirementsInput(value, fieldName));
}

export function parseStoredResourceRequirementsJson(
  value: string | null | undefined,
  fieldName = 'resourceRequirementsJson'
): ResourceRequirements | undefined {
  if (!value) return undefined;
  try {
    return normalizeResourceRequirementsInput(JSON.parse(value), fieldName);
  } catch (err) {
    if (err instanceof ResourceRequirementsValidationError) {
      throw new ResourceRequirementsValidationError(`${fieldName} is malformed: ${err.message}`);
    }
    throw new ResourceRequirementsValidationError(`${fieldName} is malformed`);
  }
}

export function collectStoredResourceRequirementLayers(
  layers: ResourceRequirementLayerJsonInput
): ResourceResolutionInput {
  const input: ResourceResolutionInput = {};
  for (const layer of RESOURCE_LAYER_ORDER) {
    const raw = layers[layer];
    if (raw === undefined || raw === null) continue;
    const parsed = parseStoredResourceRequirementsJson(raw, `${layer}.resourceRequirementsJson`);
    if (parsed !== undefined) input[layer] = parsed;
  }
  return input;
}

export function mergeResourceRequirementLayers(
  base: ResourceResolutionInput,
  overrides: ResourceResolutionInput
): ResourceResolutionInput {
  const filtered: Partial<Record<StoredResourceLayerName, ResourceRequirements>> = {};
  for (const layer of RESOURCE_LAYER_ORDER) {
    const requirements = overrides[layer];
    if (requirements !== undefined) {
      filtered[layer] = requirements;
    }
  }
  return { ...base, ...filtered };
}

export function firstResourceRequirementLayer(
  layers: ResourceResolutionInput
): ResourceRequirements | null {
  for (const layer of RESOURCE_LAYER_ORDER) {
    const requirements = layers[layer];
    if (requirements !== undefined) return requirements;
  }
  return null;
}

export function firstResourceRequirementLayerJson(layers: ResourceResolutionInput): string | null {
  const requirements = firstResourceRequirementLayer(layers);
  return requirements === null ? null : JSON.stringify(requirements);
}

export function createPersistedTaskResourcePlanJson(input: {
  layers: ResourceResolutionInput;
  resolvedReservation: ResolvedResourceReservation;
  requestedVmSize?: VMSize | null;
  requestedVmSizeSource?: ResourceRequirementsSource | null;
}): string {
  const normalizedLayers = normalizeResourceRequirementLayers(input.layers);
  const plan: PersistedTaskResourcePlan = {
    version: PERSISTED_TASK_RESOURCE_PLAN_VERSION,
    intent: intentFromLayers(normalizedLayers),
    resolvedReservation: input.resolvedReservation,
  };

  if (input.requestedVmSize !== undefined || input.requestedVmSizeSource !== undefined) {
    plan.legacyVmSize = {
      value: input.requestedVmSize ?? null,
      source: input.requestedVmSizeSource ?? null,
    };
  }

  return JSON.stringify(plan);
}

export function readPersistedTaskResourcePlan(
  input: PersistedTaskResourcePlanReadInput,
  options: PersistedTaskResourcePlanReadOptions = {}
): PersistedTaskResourcePlanReadResult {
  const requestedVmSize = parseLegacyVmSize(input.requestedVmSize);
  const requestedVmSizeSource = parseResourceRequirementsSource(input.requestedVmSizeSource);

  if (input.resourceRequirementPlanJson) {
    const parsed = parseStoredJson(
      input.resourceRequirementPlanJson,
      'resourceRequirementPlanJson'
    );
    const plan = normalizePersistedTaskResourcePlan(parsed);
    return {
      layers: layersFromIntent(plan.intent),
      resolvedReservation: plan.resolvedReservation,
      requestedVmSize: plan.legacyVmSize?.value ?? requestedVmSize,
      requestedVmSizeSource: plan.legacyVmSize?.source ?? requestedVmSizeSource,
      source: 'plan-v1',
    };
  }

  // The legacy source decides WHICH layer the stored row belongs to, so it must be
  // resolved before deciding whether an explicit task override replaces it.
  const legacyJsonSource = parseResourceRequirementsSource(input.resourceRequirementsSource);
  const legacyJson = parseLegacyResourceRequirementsJson(input, options, legacyJsonSource);
  const resolvedReservation = parseStoredResolvedReservationJson(input.resolvedReservationJson);
  if (resolvedReservation?.fieldProvenance) {
    return {
      layers: layersFromReservationProvenance(resolvedReservation),
      resolvedReservation,
      requestedVmSize,
      requestedVmSizeSource,
      source: 'reservation-provenance',
    };
  }

  if (legacyJson !== undefined) {
    if (!legacyJsonSource) {
      throw new ResourceRequirementsValidationError(
        'resourceRequirementsJson is ambiguous without resourceRequirementsSource; provide an explicit resourceRequirements replacement'
      );
    }
    const layer = SOURCE_TO_RESOURCE_LAYER[legacyJsonSource];
    if (!layer) {
      throw new ResourceRequirementsValidationError(
        `resourceRequirementsSource '${legacyJsonSource}' cannot be mapped to a persisted resource layer`
      );
    }
    return {
      layers: { [layer]: legacyJson },
      resolvedReservation,
      requestedVmSize,
      requestedVmSizeSource,
      source: 'legacy-source-json',
    };
  }

  if (requestedVmSize && requestedVmSizeSource) {
    return {
      layers: {},
      resolvedReservation,
      requestedVmSize,
      requestedVmSizeSource,
      source: 'legacy-vm-size',
    };
  }

  return {
    layers: {},
    resolvedReservation,
    requestedVmSize,
    requestedVmSizeSource,
    source: 'empty',
  };
}

export function normalizeResourceRequirementLayers(
  layers: ResourceResolutionInput
): ResourceResolutionInput {
  const normalized: ResourceResolutionInput = {};
  for (const layer of RESOURCE_LAYER_ORDER) {
    const requirements = layers[layer];
    if (requirements === undefined) continue;
    normalized[layer] = normalizeResourceRequirementsInput(
      requirements,
      `${layer}.resourceRequirements`
    );
  }
  return normalized;
}

export function parseResourceRequirementsSource(
  value: string | null | undefined
): ResourceRequirementsSource | null {
  if (!value) return null;
  return RESOURCE_REQUIREMENTS_SOURCES.has(value as ResourceRequirementsSource)
    ? (value as ResourceRequirementsSource)
    : null;
}

export function parseLegacyVmSize(value: string | null | undefined): VMSize | null {
  if (!value) return null;
  return LEGACY_VM_SIZES.has(value as VMSize) ? (value as VMSize) : null;
}

function parseLegacyResourceRequirementsJson(
  input: PersistedTaskResourcePlanReadInput,
  options: PersistedTaskResourcePlanReadOptions,
  legacyJsonSource: ResourceRequirementsSource | null
): ResourceRequirements | undefined {
  if (!input.resourceRequirementsJson) return undefined;
  if (
    options.ignoreLegacyResourceRequirementsJson &&
    legacyResourceLayerIsReplacedByTaskOverride(legacyJsonSource)
  ) {
    return undefined;
  }
  return parseStoredResourceRequirementsJson(
    input.resourceRequirementsJson,
    'resourceRequirementsJson'
  );
}

/**
 * True when an explicit task-layer replacement supersedes this stored legacy
 * row, so suppressing it cannot erase a requirement the caller did not replace.
 *
 * A `null` source is a legacy row that cannot be attributed to ANY layer — the
 * non-suppressed path rejects it as ambiguous, and no inherited layer can claim
 * it — so an explicit replacement is allowed to repair it too.
 */
function legacyResourceLayerIsReplacedByTaskOverride(
  legacyJsonSource: ResourceRequirementsSource | null
): boolean {
  if (legacyJsonSource === null) return true;
  return SOURCE_TO_RESOURCE_LAYER[legacyJsonSource] === 'task';
}

function normalizePersistedTaskResourcePlan(value: unknown): PersistedTaskResourcePlan {
  if (!isPlainObject(value)) {
    throw new ResourceRequirementsValidationError('resourceRequirementPlanJson must be an object');
  }
  if (value.version !== PERSISTED_TASK_RESOURCE_PLAN_VERSION) {
    throw new ResourceRequirementsValidationError(
      `unsupported resourceRequirementPlanJson version '${String(value.version)}'`
    );
  }
  const intentValue = value.intent;
  if (!isPlainObject(intentValue)) {
    throw new ResourceRequirementsValidationError(
      'resourceRequirementPlanJson.intent must be an object'
    );
  }
  const reservation = normalizeResolvedReservation(
    value.resolvedReservation,
    'resourceRequirementPlanJson.resolvedReservation'
  );
  const plan: PersistedTaskResourcePlan = {
    version: PERSISTED_TASK_RESOURCE_PLAN_VERSION,
    intent: intentFromUnknown(intentValue),
    resolvedReservation: reservation,
  };

  if (isPlainObject(value.legacyVmSize)) {
    const parsedVmSize = parseLegacyVmSize(stringOrNull(value.legacyVmSize.value));
    const parsedSource = parseResourceRequirementsSource(stringOrNull(value.legacyVmSize.source));
    plan.legacyVmSize = {
      value: parsedVmSize,
      source: parsedSource,
    };
  }

  return plan;
}

function parseStoredResolvedReservationJson(
  value: string | null | undefined
): ResolvedResourceReservation | null {
  if (!value) return null;
  const parsed = parseStoredJson(value, 'resolvedReservationJson');
  return normalizeResolvedReservation(parsed, 'resolvedReservationJson');
}

function normalizeResolvedReservation(
  value: unknown,
  fieldName: string
): ResolvedResourceReservation {
  if (!isPlainObject(value)) {
    throw new ResourceRequirementsValidationError(`${fieldName} must be an object`);
  }

  const source = parseResourceRequirementsSource(stringOrNull(value.source));
  if (!source) {
    throw new ResourceRequirementsValidationError(`${fieldName}.source is invalid`);
  }

  const reservation: ResolvedResourceReservation = {
    version: numberField(value.version, `${fieldName}.version`),
    cpuMillis: numberField(value.cpuMillis, `${fieldName}.cpuMillis`),
    memoryMb: numberField(value.memoryMb, `${fieldName}.memoryMb`),
    diskMb: numberField(value.diskMb, `${fieldName}.diskMb`),
    exclusiveNode: booleanField(value.exclusiveNode, `${fieldName}.exclusiveNode`),
    maxCoTenants: numberField(value.maxCoTenants, `${fieldName}.maxCoTenants`),
    source,
    sourceId: stringOrUndefined(value.sourceId) ?? '',
    fieldProvenance: normalizeReservationFieldProvenance(value.fieldProvenance, fieldName),
  };
  // `diagnostics` is semantic reservation state produced by
  // `resolveResourceReservation` (legacy vm-size adapter notes). Dropping it here
  // erased it on any no-op retry/run roundtrip, so it is preserved — including the
  // empty array the resolver always emits, which is distinguishable from absent.
  const diagnostics = normalizeReservationDiagnostics(value.diagnostics, fieldName);
  if (diagnostics !== undefined) {
    reservation.diagnostics = diagnostics;
  }
  return reservation;
}

function normalizeReservationDiagnostics(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ResourceRequirementsValidationError(`${fieldName}.diagnostics must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new ResourceRequirementsValidationError(
        `${fieldName}.diagnostics[${index}] must be a string`
      );
    }
    return entry;
  });
}

function normalizeReservationFieldProvenance(
  value: unknown,
  fieldName: string
): ResolvedResourceReservation['fieldProvenance'] {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new ResourceRequirementsValidationError(`${fieldName}.fieldProvenance must be an object`);
  }
  const provenance: NonNullable<ResolvedResourceReservation['fieldProvenance']> = {};
  for (const field of RESOURCE_REQUIREMENT_FIELDS) {
    const raw = value[field];
    if (raw === undefined || raw === null) continue;
    if (!isPlainObject(raw)) {
      throw new ResourceRequirementsValidationError(
        `${fieldName}.fieldProvenance.${field} must be an object`
      );
    }
    const source = parseResourceRequirementsSource(stringOrNull(raw.source));
    if (!source) {
      throw new ResourceRequirementsValidationError(
        `${fieldName}.fieldProvenance.${field}.source is invalid`
      );
    }
    const fieldProvenance: ResourceRequirementFieldProvenance = {
      source,
      sourceId: stringOrUndefined(raw.sourceId) ?? '',
      value:
        field === 'exclusiveNode'
          ? booleanField(raw.value, `${fieldName}.fieldProvenance.${field}.value`)
          : numberField(raw.value, `${fieldName}.fieldProvenance.${field}.value`),
    };
    // The legacy vm-size adapter records which adapter/version translated which
    // legacy size into this field. Dropping it erased the audit trail on a
    // no-op retry, leaving a translated value indistinguishable from an
    // explicitly authored one.
    const compatibility = normalizeReservationFieldCompatibility(
      raw.compatibility,
      `${fieldName}.fieldProvenance.${field}`
    );
    if (compatibility !== undefined) {
      fieldProvenance.compatibility = compatibility;
    }
    provenance[field] = fieldProvenance;
  }
  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

function normalizeReservationFieldCompatibility(
  value: unknown,
  fieldName: string
): ResourceRequirementFieldProvenance['compatibility'] {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new ResourceRequirementsValidationError(`${fieldName}.compatibility must be an object`);
  }
  const adapter = stringOrNull(value.adapter);
  if (!adapter) {
    throw new ResourceRequirementsValidationError(`${fieldName}.compatibility.adapter is invalid`);
  }
  const legacyVmSize = parseLegacyVmSize(stringOrNull(value.legacyVmSize));
  if (!legacyVmSize) {
    throw new ResourceRequirementsValidationError(
      `${fieldName}.compatibility.legacyVmSize is invalid`
    );
  }
  return {
    adapter,
    version: numberField(value.version, `${fieldName}.compatibility.version`),
    legacyVmSize,
  };
}

function layersFromReservationProvenance(
  reservation: ResolvedResourceReservation
): ResourceResolutionInput {
  const layers: ResourceResolutionInput = {};
  const provenance = reservation.fieldProvenance;
  if (!provenance) return layers;

  for (const field of RESOURCE_REQUIREMENT_FIELDS) {
    const fieldProvenance = provenance[field];
    if (!fieldProvenance) continue;
    const layer = SOURCE_TO_RESOURCE_LAYER[fieldProvenance.source];
    if (!layer) continue;
    const nextLayer = (layers[layer] ?? {}) as ResourceRequirements;
    if (field === 'exclusiveNode') {
      nextLayer.exclusiveNode = fieldProvenance.value as boolean;
    } else if (field === 'minVcpu') {
      nextLayer.minVcpu = fieldProvenance.value as number;
    } else if (field === 'minMemoryGb') {
      nextLayer.minMemoryGb = fieldProvenance.value as number;
    } else if (field === 'minDiskGb') {
      nextLayer.minDiskGb = fieldProvenance.value as number;
    } else if (field === 'maxCoTenants') {
      nextLayer.maxCoTenants = fieldProvenance.value as number;
    }
    layers[layer] = normalizeResourceRequirementsInput(nextLayer, `${layer}.resourceRequirements`);
  }

  return layers;
}

function intentFromLayers(
  layers: ResourceResolutionInput
): Record<StoredResourceLayerName, ResourceRequirements | null> {
  const intent = Object.fromEntries(RESOURCE_LAYER_ORDER.map((layer) => [layer, null])) as Record<
    StoredResourceLayerName,
    ResourceRequirements | null
  >;
  for (const layer of RESOURCE_LAYER_ORDER) {
    const requirements = layers[layer];
    if (requirements !== undefined) {
      intent[layer] = normalizeResourceRequirementsInput(
        requirements,
        `${layer}.resourceRequirements`
      );
    }
  }
  return intent;
}

function intentFromUnknown(
  value: Record<string, unknown>
): Record<StoredResourceLayerName, ResourceRequirements | null> {
  const intent = Object.fromEntries(RESOURCE_LAYER_ORDER.map((layer) => [layer, null])) as Record<
    StoredResourceLayerName,
    ResourceRequirements | null
  >;
  for (const layer of RESOURCE_LAYER_ORDER) {
    const requirements = value[layer];
    if (requirements === undefined || requirements === null) continue;
    intent[layer] = normalizeResourceRequirementsInput(
      requirements,
      `resourceRequirementPlanJson.intent.${layer}`
    );
  }
  return intent;
}

function layersFromIntent(
  intent: Record<StoredResourceLayerName, ResourceRequirements | null>
): ResourceResolutionInput {
  const layers: ResourceResolutionInput = {};
  for (const layer of RESOURCE_LAYER_ORDER) {
    const requirements = intent[layer];
    if (requirements !== null) layers[layer] = requirements;
  }
  return layers;
}

function parseStoredJson(value: string, fieldName: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ResourceRequirementsValidationError(`${fieldName} is malformed`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberField(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ResourceRequirementsValidationError(`${fieldName} must be a number`);
  }
  return value;
}

function booleanField(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ResourceRequirementsValidationError(`${fieldName} must be a boolean`);
  }
  return value;
}
