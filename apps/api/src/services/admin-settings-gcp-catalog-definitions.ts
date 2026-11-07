import { GCP_MACHINE_TYPE_NAME_PATTERN } from '@simple-agent-manager/providers';

import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';

export type GcpCatalogSettingName =
  | 'gcpCatalog.machineTypes'
  | 'gcpCatalog.priceTableTtlMinutes'
  | 'gcpCatalog.priceRetryMinutes'
  | 'gcpCatalog.priceMaxPages'
  | 'gcpCatalog.priceRequestTimeoutMs'
  | 'gcpCatalog.priceRefreshCredentialAttempts';

/**
 * General-purpose shapes SAM offers from Google Cloud by default: shared-core e2-medium, and the
 * standard e2, n2d and t2d types up to 16 vCPUs. Zones are not listed anywhere; they come from
 * Google for whichever of these types exist.
 */
export const DEFAULT_GCP_CATALOG_MACHINE_TYPES: readonly string[] = Object.freeze([
  'e2-medium',
  'e2-standard-2',
  'e2-standard-4',
  'e2-standard-8',
  'e2-standard-16',
  'n2d-standard-2',
  'n2d-standard-4',
  'n2d-standard-8',
  'n2d-standard-16',
  't2d-standard-1',
  't2d-standard-2',
  't2d-standard-4',
  't2d-standard-8',
  't2d-standard-16',
]);
export const MAX_GCP_CATALOG_MACHINE_TYPES = 100;

export const GCP_CATALOG_SETTINGS: readonly AdminSettingDefinition[] = [
  {
    name: 'gcpCatalog.machineTypes',
    type: 'string-list',
    defaultValue: DEFAULT_GCP_CATALOG_MACHINE_TYPES,
    category: 'Operations',
    description:
      'Google Cloud machine types SAM offers, by exact name (for example e2-standard-4). Every zone where Google has the type is offered.',
    secret: false,
    risky: true,
    validate: (value) =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= MAX_GCP_CATALOG_MACHINE_TYPES &&
      new Set(value).size === value.length &&
      value.every((name) => typeof name === 'string' && GCP_MACHINE_TYPE_NAME_PATTERN.test(name)),
  },
  integerDefinition(
    'gcpCatalog.priceTableTtlMinutes',
    24 * 60,
    'Operations',
    'Minutes before SAM re-reads Google Cloud list prices from the Cloud Billing Catalog.',
    { min: 60, max: 7 * 24 * 60 }
  ),
  integerDefinition(
    'gcpCatalog.priceRetryMinutes',
    60,
    'Operations',
    'Minutes SAM waits after a failed Google Cloud price refresh before trying again.',
    { min: 5, max: 24 * 60 }
  ),
  integerDefinition(
    'gcpCatalog.priceMaxPages',
    20,
    'Operations',
    'Most pages of Google Cloud price data read in one refresh. A refresh that needs more fails rather than storing a partial price list.',
    { min: 1, max: 200 }
  ),
  integerDefinition(
    'gcpCatalog.priceRequestTimeoutMs',
    30_000,
    'Operations',
    'Maximum milliseconds per request when reading Google Cloud prices.',
    { min: 1_000, max: 120_000 }
  ),
  integerDefinition(
    'gcpCatalog.priceRefreshCredentialAttempts',
    3,
    'Operations',
    'Connected Google Cloud credentials tried per price refresh, platform credentials first, so one without the Cloud Billing API enabled does not block the rest.',
    { min: 1, max: 20 }
  ),
];
