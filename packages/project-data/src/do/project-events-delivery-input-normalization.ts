import {
  type CreateProjectEventDeliveryBatchInput,
  PROJECT_EVENT_DELIVERY_ADAPTER_KINDS,
  PROJECT_EVENT_DELIVERY_CAPABILITY_MODES,
  PROJECT_EVENT_DELIVERY_TARGET_STATES,
  type ProjectEventDeliveryAdapterCapability,
  type ProjectEventDeliveryAdapterVersionGate,
  type ProjectEventDeliveryAuthorization,
  type ProjectEventDeliveryTargetState,
  type ProjectEventLimits,
} from '@simple-agent-manager/shared';

import {
  ProjectEventLimitExceededError,
  ProjectEventValidationError,
} from './project-events-contracts';
import { isPlainObject, normalizeNullableText, normalizeText } from './project-events-values';

const DELIVERY_CAPABILITY_SET = new Set<string>(PROJECT_EVENT_DELIVERY_CAPABILITY_MODES);
const DELIVERY_ADAPTER_KIND_SET = new Set<string>(PROJECT_EVENT_DELIVERY_ADAPTER_KINDS);
const DELIVERY_TARGET_STATE_SET = new Set<string>(PROJECT_EVENT_DELIVERY_TARGET_STATES);

export function normalizeAdapterCapabilities(
  input: CreateProjectEventDeliveryBatchInput['adapterCapabilities'],
  limits: ProjectEventLimits
): ProjectEventDeliveryAdapterCapability[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new ProjectEventValidationError('adapterCapabilities must be an array');
  }
  if (input.length > limits.maxAttemptsPerBatch) {
    throw new ProjectEventLimitExceededError(
      `adapterCapabilities must contain ${limits.maxAttemptsPerBatch} entries or fewer`
    );
  }
  return input
    .map((item, index) => normalizeAdapterCapability(item, index, limits))
    .sort((a, b) => a.adapterId.localeCompare(b.adapterId));
}

export function normalizeDeliveryAuthorization(
  input: CreateProjectEventDeliveryBatchInput['authorization']
): ProjectEventDeliveryAuthorization {
  if (input === null || input === undefined) {
    return {
      allowPromptQueue: false,
      allowRuntimeSteer: false,
      allowRuntimeInterrupt: false,
      allowTaskSpawn: false,
    };
  }
  if (!isPlainObject(input)) {
    throw new ProjectEventValidationError('authorization must be an object');
  }
  return {
    allowPromptQueue: normalizeOptionalBoolean(
      input.allowPromptQueue,
      false,
      'authorization.allowPromptQueue'
    ),
    allowRuntimeSteer: normalizeOptionalBoolean(
      input.allowRuntimeSteer,
      false,
      'authorization.allowRuntimeSteer'
    ),
    allowRuntimeInterrupt: normalizeOptionalBoolean(
      input.allowRuntimeInterrupt,
      false,
      'authorization.allowRuntimeInterrupt'
    ),
    allowTaskSpawn: normalizeOptionalBoolean(
      input.allowTaskSpawn,
      false,
      'authorization.allowTaskSpawn'
    ),
  };
}

export function normalizeDeliveryTargetState(
  input: CreateProjectEventDeliveryBatchInput['targetState']
): ProjectEventDeliveryTargetState | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string' || !DELIVERY_TARGET_STATE_SET.has(input)) {
    throw new ProjectEventValidationError('targetState is not allowed');
  }
  return input;
}

function normalizeAdapterCapability(
  input: ProjectEventDeliveryAdapterCapability,
  index: number,
  limits: ProjectEventLimits
): ProjectEventDeliveryAdapterCapability {
  if (!isPlainObject(input)) {
    throw new ProjectEventValidationError(`adapterCapabilities[${index}] must be an object`);
  }
  if (typeof input.adapterKind !== 'string' || !DELIVERY_ADAPTER_KIND_SET.has(input.adapterKind)) {
    throw new ProjectEventValidationError(
      `adapterCapabilities[${index}].adapterKind is not allowed`
    );
  }
  return {
    adapterId: normalizeText(
      input.adapterId,
      `adapterCapabilities[${index}].adapterId`,
      limits.maxFilterStringBytes
    ),
    adapterKind: input.adapterKind,
    agentType: normalizeNullableText(
      input.agentType ?? null,
      `adapterCapabilities[${index}].agentType`,
      limits.maxFilterStringBytes
    ),
    protocol: normalizeNullableText(
      input.protocol ?? null,
      `adapterCapabilities[${index}].protocol`,
      limits.maxFilterStringBytes
    ),
    protocolVersion: normalizeNullableText(
      input.protocolVersion ?? null,
      `adapterCapabilities[${index}].protocolVersion`,
      limits.maxFilterStringBytes
    ),
    capabilities: normalizeDeliveryCapabilityModes(input.capabilities, index, limits),
    durableAck: normalizeBoolean(input.durableAck, `adapterCapabilities[${index}].durableAck`),
    available: normalizeOptionalBoolean(
      input.available,
      true,
      `adapterCapabilities[${index}].available`
    ),
    versionGate: normalizeAdapterVersionGate(input.versionGate, index, limits),
  };
}

function normalizeDeliveryCapabilityModes(
  input: ProjectEventDeliveryAdapterCapability['capabilities'],
  index: number,
  limits: ProjectEventLimits
): ProjectEventDeliveryAdapterCapability['capabilities'] {
  if (!Array.isArray(input)) {
    throw new ProjectEventValidationError(
      `adapterCapabilities[${index}].capabilities must be an array`
    );
  }
  if (input.length > PROJECT_EVENT_DELIVERY_CAPABILITY_MODES.length) {
    throw new ProjectEventLimitExceededError(
      `adapterCapabilities[${index}].capabilities must contain ${PROJECT_EVENT_DELIVERY_CAPABILITY_MODES.length} entries or fewer`
    );
  }
  const capabilities = [
    ...new Set(
      input.map((item, capabilityIndex) =>
        normalizeText(
          item,
          `adapterCapabilities[${index}].capabilities[${capabilityIndex}]`,
          limits.maxFilterStringBytes
        )
      )
    ),
  ].sort((a, b) => a.localeCompare(b));
  for (const capability of capabilities) {
    if (!DELIVERY_CAPABILITY_SET.has(capability)) {
      throw new ProjectEventValidationError(
        `adapterCapabilities[${index}].capabilities contains an unsupported capability`
      );
    }
  }
  return capabilities as ProjectEventDeliveryAdapterCapability['capabilities'];
}

function normalizeAdapterVersionGate(
  input: ProjectEventDeliveryAdapterVersionGate | null | undefined,
  index: number,
  limits: ProjectEventLimits
): ProjectEventDeliveryAdapterVersionGate | null {
  if (input === null || input === undefined) return null;
  if (!isPlainObject(input)) {
    throw new ProjectEventValidationError(
      `adapterCapabilities[${index}].versionGate must be an object`
    );
  }
  return {
    dependencyName: normalizeNullableText(
      input.dependencyName ?? null,
      `adapterCapabilities[${index}].versionGate.dependencyName`,
      limits.maxFilterStringBytes
    ),
    currentVersion: normalizeNullableText(
      input.currentVersion ?? null,
      `adapterCapabilities[${index}].versionGate.currentVersion`,
      limits.maxFilterStringBytes
    ),
    minimumVersion: normalizeNullableText(
      input.minimumVersion ?? null,
      `adapterCapabilities[${index}].versionGate.minimumVersion`,
      limits.maxFilterStringBytes
    ),
    satisfied: normalizeBoolean(
      input.satisfied,
      `adapterCapabilities[${index}].versionGate.satisfied`
    ),
  };
}

function normalizeOptionalBoolean(input: unknown, fallback: boolean, field: string): boolean {
  if (input === null || input === undefined) return fallback;
  return normalizeBoolean(input, field);
}

function normalizeBoolean(input: unknown, field: string): boolean {
  if (typeof input !== 'boolean') {
    throw new ProjectEventValidationError(`${field} must be a boolean`);
  }
  return input;
}
