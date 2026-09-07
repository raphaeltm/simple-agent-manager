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
  normalizeResourceRequirements,
  PLATFORM_RESOURCE_DEFAULTS,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export const CAPACITY_POOL_LEGACY_WORKLOAD_MAPPING_SETTING_KEY =
  'capacityPools.legacyWorkloadMapping.v1';
export const CAPACITY_POOL_SELECTION_SETTINGS_SETTING_KEY = 'capacityPools.selectionSettings.v1';
export const CAPACITY_POOL_PLATFORM_DEFAULTS_SETTING_KEY = 'capacityPools.platformDefaults.v1';

type PlacementSettingsSource = 'persisted' | 'environment' | 'default';

export const DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS: Pick<
  CapacityPoolPlacementSettings,
  | 'version'
  | 'sourceGeneration'
  | 'legacyWorkloadAdapterVersion'
  | 'selectionWeights'
  | 'rolloutCohortPercent'
> = {
  version: 1,
  sourceGeneration: 1,
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
    platformDefaults: Required<ResourceRequirements>;
  };
  placementSettings: CapacityPoolPlacementSettings;
}

export async function resolveCapacityPoolPlacementSettings(
  db: Db,
  env?: Pick<
    Env,
    | 'CAPACITY_POOL_LEGACY_WORKLOAD_MAPPING_JSON'
    | 'CAPACITY_POOL_SELECTION_SETTINGS_JSON'
    | 'CAPACITY_POOL_PLATFORM_DEFAULTS_JSON'
  >
): Promise<ResolvedCapacityPoolPlacementSettings> {
  const rows = await db
    .select({
      key: schema.platformSettings.key,
      value: schema.platformSettings.value,
      updatedAt: schema.platformSettings.updatedAt,
    })
    .from(schema.platformSettings)
    .where(eq(schema.platformSettings.key, CAPACITY_POOL_LEGACY_WORKLOAD_MAPPING_SETTING_KEY));
  const selectionRows = await db
    .select({
      key: schema.platformSettings.key,
      value: schema.platformSettings.value,
      updatedAt: schema.platformSettings.updatedAt,
    })
    .from(schema.platformSettings)
    .where(eq(schema.platformSettings.key, CAPACITY_POOL_SELECTION_SETTINGS_SETTING_KEY));
  const platformDefaultRows = await db
    .select({
      key: schema.platformSettings.key,
      value: schema.platformSettings.value,
      updatedAt: schema.platformSettings.updatedAt,
    })
    .from(schema.platformSettings)
    .where(eq(schema.platformSettings.key, CAPACITY_POOL_PLATFORM_DEFAULTS_SETTING_KEY));

  const diagnostics: string[] = [];
  const persistedMapping = rows[0] ?? null;
  const envMapping = env?.CAPACITY_POOL_LEGACY_WORKLOAD_MAPPING_JSON ?? null;
  const legacyMappingResult =
    parseLegacyWorkloadMapping(persistedMapping?.value, 'persisted', diagnostics) ??
    parseLegacyWorkloadMapping(envMapping, 'environment', diagnostics) ??
    defaultLegacyWorkloadMappingResult();

  const persistedSelection = selectionRows[0] ?? null;
  const envSelection = env?.CAPACITY_POOL_SELECTION_SETTINGS_JSON ?? null;
  const selectionResult =
    parseSelectionSettings(persistedSelection?.value, 'persisted', diagnostics) ??
    parseSelectionSettings(envSelection, 'environment', diagnostics);
  const selectionSource = selectionResult?.source ?? 'default';
  const selectionWeights =
    selectionResult?.selectionWeights ?? DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.selectionWeights;
  const rolloutCohortPercent =
    selectionResult?.rolloutCohortPercent ??
    DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.rolloutCohortPercent;

  const persistedPlatformDefaults = platformDefaultRows[0] ?? null;
  const envPlatformDefaults = env?.CAPACITY_POOL_PLATFORM_DEFAULTS_JSON ?? null;
  const platformDefaultsResult =
    parsePlatformDefaults(persistedPlatformDefaults?.value, 'persisted', diagnostics) ??
    parsePlatformDefaults(envPlatformDefaults, 'environment', diagnostics) ??
    defaultPlatformDefaultsResult();

  return {
    resourceDefaults: {
      legacyWorkloadMapping: legacyMappingResult.mapping,
      platformDefaults: platformDefaultsResult.defaults,
    },
    placementSettings: {
      version: DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.version,
      sourceGeneration: sourceGenerationForSelectedSettings({
        legacyWorkloadMapping: legacyMappingResult.mapping,
        platformDefaults: platformDefaultsResult.defaults,
        selectionWeights,
        rolloutCohortPercent,
      }),
      legacyWorkloadAdapterVersion:
        DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.legacyWorkloadAdapterVersion,
      selectionWeights,
      rolloutCohortPercent,
      source: {
        legacyWorkloadMapping: legacyMappingResult.source,
        platformDefaults: platformDefaultsResult.source,
        selection: selectionSource,
      },
      diagnostics,
    },
  };
}

function parseLegacyWorkloadMapping(
  raw: string | null | undefined,
  source: Exclude<PlacementSettingsSource, 'default'>,
  diagnostics: string[]
): {
  source: Exclude<PlacementSettingsSource, 'default'>;
  mapping: Record<VMSize, Required<ResourceRequirements>>;
} | null {
  const parsed = parseJsonRecord(raw, `${source}:legacyWorkloadMapping`, diagnostics);
  if (!parsed) return null;

  const mapping: Partial<Record<VMSize, Required<ResourceRequirements>>> = {};
  for (const size of ['small', 'medium', 'large'] as const) {
    const value = parsed[size];
    if (!isJsonRecord(value)) {
      diagnostics.push(`${source}:legacyWorkloadMapping.${size}:invalid`);
      return null;
    }
    try {
      mapping[size] = normalizeResourceRequirements(value, {
        requireAllFields: true,
      }) as Required<ResourceRequirements>;
    } catch {
      diagnostics.push(`${source}:legacyWorkloadMapping.${size}:invalid`);
      return null;
    }
  }

  return { source, mapping: mapping as Record<VMSize, Required<ResourceRequirements>> };
}

function defaultLegacyWorkloadMappingResult(): {
  source: 'default';
  mapping: Record<VMSize, Required<ResourceRequirements>>;
} {
  return { source: 'default', mapping: DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS };
}

function parsePlatformDefaults(
  raw: string | null | undefined,
  source: Exclude<PlacementSettingsSource, 'default'>,
  diagnostics: string[]
): {
  source: Exclude<PlacementSettingsSource, 'default'>;
  defaults: Required<ResourceRequirements>;
} | null {
  const parsed = parseJsonRecord(raw, `${source}:platformDefaults`, diagnostics);
  if (!parsed) return null;
  try {
    return {
      source,
      defaults: normalizeResourceRequirements(parsed, {
        requireAllFields: true,
      }) as Required<ResourceRequirements>,
    };
  } catch {
    diagnostics.push(`${source}:platformDefaults:invalid`);
    return null;
  }
}

function defaultPlatformDefaultsResult(): {
  source: 'default';
  defaults: Required<ResourceRequirements>;
} {
  return { source: 'default', defaults: PLATFORM_RESOURCE_DEFAULTS };
}

function parseSelectionSettings(
  raw: string | null | undefined,
  source: 'persisted' | 'environment',
  diagnostics: string[]
):
  | (Pick<CapacityPoolPlacementSettings, 'selectionWeights' | 'rolloutCohortPercent'> & {
      source: 'persisted' | 'environment';
    })
  | null {
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
      : null;
  if (rolloutCohortPercent === null) {
    diagnostics.push(`${source}:selectionSettings.rolloutCohortPercent:invalid`);
    return null;
  }

  return { source, selectionWeights: weights, rolloutCohortPercent };
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

function sourceGenerationForSelectedSettings(input: {
  legacyWorkloadMapping: Record<VMSize, Required<ResourceRequirements>>;
  platformDefaults: Required<ResourceRequirements>;
  selectionWeights: CapacityPoolSelectionWeights;
  rolloutCohortPercent: number;
}): number {
  return stablePositiveHash(
    stableStringify({
      version: DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.version,
      legacyWorkloadAdapterVersion:
        DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.legacyWorkloadAdapterVersion,
      legacyWorkloadMapping: input.legacyWorkloadMapping,
      platformDefaults: input.platformDefaults,
      selectionWeights: input.selectionWeights,
      rolloutCohortPercent: input.rolloutCohortPercent,
    })
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function stablePositiveHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS.sourceGeneration;
}

function nonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
