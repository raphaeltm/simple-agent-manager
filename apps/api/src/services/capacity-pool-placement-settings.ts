import type {
  CapacityPoolPlacementSettings,
  CapacityPoolSelectionWeights,
  ResourceRequirements,
  VMSize,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS,
  isJsonRecord,
  LEGACY_VM_SIZE_WORKLOAD_ADAPTER_VERSION,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export const CAPACITY_POOL_LEGACY_WORKLOAD_MAPPING_SETTING_KEY =
  'capacityPools.legacyWorkloadMapping.v1';
export const CAPACITY_POOL_SELECTION_SETTINGS_SETTING_KEY = 'capacityPools.selectionSettings.v1';

export const DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS: Pick<
  CapacityPoolPlacementSettings,
  'version' | 'legacyWorkloadAdapterVersion' | 'selectionWeights' | 'rolloutCohortPercent'
> = {
  version: 1,
  legacyWorkloadAdapterVersion: LEGACY_VM_SIZE_WORKLOAD_ADAPTER_VERSION,
  selectionWeights: {
    priority: 100_000_000,
    price: 1,
    fit: 1_000_000,
    capacity: 1,
    candidateOrder: 1,
  },
  rolloutCohortPercent: 100,
};

export interface ResolvedCapacityPoolPlacementSettings {
  resourceDefaults: {
    legacyWorkloadMapping: Record<VMSize, Required<ResourceRequirements>>;
  };
  placementSettings: CapacityPoolPlacementSettings;
}

export async function resolveCapacityPoolPlacementSettings(
  db: Db,
  env?: Pick<
    Env,
    'CAPACITY_POOL_LEGACY_WORKLOAD_MAPPING_JSON' | 'CAPACITY_POOL_SELECTION_SETTINGS_JSON'
  >
): Promise<ResolvedCapacityPoolPlacementSettings> {
  const rows = await db
    .select({ key: schema.platformSettings.key, value: schema.platformSettings.value })
    .from(schema.platformSettings)
    .where(
      eq(
        schema.platformSettings.key,
        CAPACITY_POOL_LEGACY_WORKLOAD_MAPPING_SETTING_KEY
      )
    );
  const selectionRows = await db
    .select({ key: schema.platformSettings.key, value: schema.platformSettings.value })
    .from(schema.platformSettings)
    .where(eq(schema.platformSettings.key, CAPACITY_POOL_SELECTION_SETTINGS_SETTING_KEY));

  const diagnostics: string[] = [];
  const persistedMapping = rows[0]?.value ?? null;
  const envMapping = env?.CAPACITY_POOL_LEGACY_WORKLOAD_MAPPING_JSON ?? null;
  const legacyMapping = parseLegacyWorkloadMapping(
    persistedMapping,
    'persisted',
    diagnostics
  ) ??
    parseLegacyWorkloadMapping(envMapping, 'environment', diagnostics) ??
    DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS;

  const persistedSelection = selectionRows[0]?.value ?? null;
  const envSelection = env?.CAPACITY_POOL_SELECTION_SETTINGS_JSON ?? null;
  const selectionResult =
    parseSelectionSettings(persistedSelection, 'persisted', diagnostics) ??
    parseSelectionSettings(envSelection, 'environment', diagnostics);

  return {
    resourceDefaults: {
      legacyWorkloadMapping: legacyMapping,
    },
    placementSettings: {
      version: DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.version,
      legacyWorkloadAdapterVersion:
        DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.legacyWorkloadAdapterVersion,
      selectionWeights:
        selectionResult?.selectionWeights ??
        DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.selectionWeights,
      rolloutCohortPercent:
        selectionResult?.rolloutCohortPercent ??
        DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.rolloutCohortPercent,
      source: {
        legacyWorkloadMapping: persistedMapping
          ? 'persisted'
          : envMapping
            ? 'environment'
            : 'default',
        selection: persistedSelection ? 'persisted' : envSelection ? 'environment' : 'default',
      },
      diagnostics,
    },
  };
}

function parseLegacyWorkloadMapping(
  raw: string | null | undefined,
  source: 'persisted' | 'environment',
  diagnostics: string[]
): Record<VMSize, Required<ResourceRequirements>> | null {
  const parsed = parseJsonRecord(raw, `${source}:legacyWorkloadMapping`, diagnostics);
  if (!parsed) return null;

  const mapping: Partial<Record<VMSize, Required<ResourceRequirements>>> = {};
  for (const size of ['small', 'medium', 'large'] as const) {
    const value = parsed[size];
    if (!isJsonRecord(value)) {
      diagnostics.push(`${source}:legacyWorkloadMapping.${size}:invalid`);
      return null;
    }
    const requirements = normalizeRequirements(value);
    if (!requirements) {
      diagnostics.push(`${source}:legacyWorkloadMapping.${size}:invalid`);
      return null;
    }
    mapping[size] = requirements;
  }

  return mapping as Record<VMSize, Required<ResourceRequirements>>;
}

function parseSelectionSettings(
  raw: string | null | undefined,
  source: 'persisted' | 'environment',
  diagnostics: string[]
): Pick<CapacityPoolPlacementSettings, 'selectionWeights' | 'rolloutCohortPercent'> | null {
  const parsed = parseJsonRecord(raw, `${source}:selectionSettings`, diagnostics);
  if (!parsed) return null;

  const weightsRaw = parsed.selectionWeights;
  const weights = isJsonRecord(weightsRaw) ? normalizeSelectionWeights(weightsRaw) : null;
  if (!weights) {
    diagnostics.push(`${source}:selectionSettings.selectionWeights:invalid`);
    return null;
  }

  const rolloutCohortPercent =
    typeof parsed.rolloutCohortPercent === 'number' &&
    Number.isFinite(parsed.rolloutCohortPercent) &&
    parsed.rolloutCohortPercent >= 0 &&
    parsed.rolloutCohortPercent <= 100
      ? parsed.rolloutCohortPercent
      : DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.rolloutCohortPercent;

  return { selectionWeights: weights, rolloutCohortPercent };
}

function parseJsonRecord(
  raw: string | null | undefined,
  label: string,
  diagnostics: string[]
): Record<string, unknown> | null {
  if (!raw?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isJsonRecord(parsed)) return parsed;
    diagnostics.push(`${label}:not-object`);
    return null;
  } catch {
    diagnostics.push(`${label}:invalid-json`);
    return null;
  }
}

function normalizeRequirements(
  value: Record<string, unknown>
): Required<ResourceRequirements> | null {
  const minVcpu = positiveFiniteNumber(value.minVcpu);
  const minMemoryGb = positiveFiniteNumber(value.minMemoryGb);
  const minDiskGb = nonNegativeFiniteNumber(value.minDiskGb);
  const maxCoTenants = positiveInteger(value.maxCoTenants);
  const exclusiveNode = typeof value.exclusiveNode === 'boolean' ? value.exclusiveNode : null;
  if (
    minVcpu === null ||
    minMemoryGb === null ||
    minDiskGb === null ||
    maxCoTenants === null ||
    exclusiveNode === null
  ) {
    return null;
  }
  return { minVcpu, minMemoryGb, minDiskGb, exclusiveNode, maxCoTenants };
}

function normalizeSelectionWeights(
  value: Record<string, unknown>
): CapacityPoolSelectionWeights | null {
  const priority = nonNegativeFiniteNumber(value.priority);
  const price = nonNegativeFiniteNumber(value.price);
  const fit = nonNegativeFiniteNumber(value.fit);
  const capacity = nonNegativeFiniteNumber(value.capacity);
  const candidateOrder = nonNegativeFiniteNumber(value.candidateOrder);
  if (
    priority === null ||
    price === null ||
    fit === null ||
    capacity === null ||
    candidateOrder === null
  ) {
    return null;
  }
  return { priority, price, fit, capacity, candidateOrder };
}

function positiveFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
