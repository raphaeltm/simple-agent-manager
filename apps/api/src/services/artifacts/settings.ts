/** Resource policy metadata for an optional repository backend; contains no git implementation. */
import { type AdminSettingDefinition, integerDefinition } from '../admin-setting-definitions';

export const REPOSITORY_POLICY_DEFAULTS = {
  maxPushBytes: 64 * 1024 * 1024,
  maxRepoObjects: 30_000,
  // At 255 characters per ref, even UTF-8 advertisements stay below 12 MiB.
  maxRepoRefs: 10_000,
  maxRepoBytes: 256 * 1024 * 1024,
  maxObjectBytes: 16 * 1024 * 1024,
  maxInflatedBytes: 128 * 1024 * 1024,
  maxDeltaDepth: 100,
  workTimeoutMs: 120_000,
} as const;

export type RepositoryPolicyKey = keyof typeof REPOSITORY_POLICY_DEFAULTS;
export type RepositorySettingName = `repositories.${RepositoryPolicyKey}`;

export const REPOSITORY_SETTINGS: readonly AdminSettingDefinition[] = (
  Object.entries(REPOSITORY_POLICY_DEFAULTS) as [RepositoryPolicyKey, number][]
).map(([key, value]) =>
  integerDefinition(
    `repositories.${key}`,
    value,
    'Operations',
    `Resource bound ${key} for the installation's optional local repository backend.`,
    { min: 1, max: value }
  )
);
