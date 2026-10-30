import type {
  CredentialProvider,
  ProviderCatalog,
  ProviderCatalogRefreshStatus,
  ProviderInstanceOffering,
} from '@simple-agent-manager/shared';
import { type drizzle } from 'drizzle-orm/d1';

export type Db = ReturnType<typeof drizzle>;

export type ProviderCatalogCredentialSource = 'user' | 'project' | 'platform';

export interface ProviderCatalogCredentialSeed {
  id: string;
  provider: CredentialProvider;
  encryptedToken: string;
  iv: string;
  credentialSource: ProviderCatalogCredentialSource;
  credentialId: string | null;
  platformCredentialId: string | null;
  capacitySourceCredentialId: string | null;
  credentialReference: string;
  credentialVersion: number | null;
  externalSourceRef: string | null;
  active: boolean;
  createdBy: string | null;
  stateFingerprint: string;
}

export interface ProviderCatalogListResult {
  catalogs: ProviderCatalog[];
  credentialCount: number;
  refreshFailures: Array<{
    provider: CredentialProvider;
    credentialSource: ProviderCatalogCredentialSource;
    reason: 'provider-unavailable';
  }>;
}

export interface ProviderCatalogOfferingResolution {
  offerings: ProviderInstanceOffering[];
  refreshStatus: ProviderCatalogRefreshStatus;
}

export const DEFAULT_PROVIDER_CATALOG_TIMEOUT_MS = 10_000;
