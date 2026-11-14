import { GCP_MACHINE_TYPE_NAME_PATTERN } from '@simple-agent-manager/providers';
import {
  DEFAULT_GCP_BOOT_DISK_GB_PER_VCPU,
  DEFAULT_GCP_BOOT_DISK_MIN_GB,
  GCP_BOOT_DISK_FLOOR_GB,
  GCP_BOOT_DISK_MAX_GB,
} from '@simple-agent-manager/shared';

import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';

export type GcpCatalogSettingName =
  | 'gcpCatalog.machineTypes'
  | 'gcpCatalog.priceTableTtlMinutes'
  | 'gcpCatalog.priceRetryMinutes'
  | 'gcpCatalog.priceMaxPages'
  | 'gcpCatalog.priceRequestTimeoutMs'
  | 'gcpCatalog.priceRefreshCredentialAttempts'
  | 'gcpCatalog.priceRefreshBudgetMs'
  | 'gcpCatalog.apiIssueTtlMinutes'
  | 'gcpCatalog.bootDiskGbPerVcpu'
  | 'gcpCatalog.bootDiskMinGb';

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
    'Connected Google Cloud credentials tried per price refresh, platform credentials first. A retry after a failed refresh continues with the next credentials, so ones without the Cloud Billing API enabled do not block the rest.',
    { min: 1, max: 20 }
  ),
  integerDefinition(
    'gcpCatalog.priceRefreshBudgetMs',
    90_000,
    'Operations',
    'Maximum milliseconds one Google Cloud price refresh may take across all credentials it tries. It runs inside the 5-minute scheduled job, so it must stay well below that.',
    { min: 10_000, max: 240_000 }
  ),
  integerDefinition(
    'gcpCatalog.apiIssueTtlMinutes',
    7 * 24 * 60,
    'Operations',
    'Minutes SAM keeps showing a Google API problem (for example Cloud Billing disabled) on a Google Cloud credential after Google last reported it. A successful check clears it sooner.',
    { min: 60, max: 30 * 24 * 60 }
  ),
  integerDefinition(
    'gcpCatalog.bootDiskGbPerVcpu',
    DEFAULT_GCP_BOOT_DISK_GB_PER_VCPU,
    'Operations',
    'GB of boot disk SAM gives a new Google Cloud VM per vCPU (an 8-vCPU machine gets 8 times this), so bigger machines hold more workspaces. Applies to the catalog, prices and new VMs from the next catalog refresh; running VMs keep their disk.',
    { min: 1, max: 256 }
  ),
  integerDefinition(
    'gcpCatalog.bootDiskMinGb',
    DEFAULT_GCP_BOOT_DISK_MIN_GB,
    'Operations',
    'Smallest boot disk, in GB, SAM gives a new Google Cloud VM, whatever its vCPU count.',
    { min: GCP_BOOT_DISK_FLOOR_GB, max: GCP_BOOT_DISK_MAX_GB }
  ),
];
