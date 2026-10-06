import type { ProviderCatalogResponse } from '@simple-agent-manager/shared';

import { request } from './client';

export interface ProviderCatalogRequestOptions {
  scope?: 'user' | 'project' | 'installation';
  projectId?: string | null;
}

function providerCatalogPath(options?: ProviderCatalogRequestOptions): string {
  if (!options?.scope) return '/api/providers/catalog';

  const params = new URLSearchParams({ scope: options.scope });
  if (options.projectId) params.set('projectId', options.projectId);
  return `/api/providers/catalog?${params.toString()}`;
}

export async function getProviderCatalog(
  options?: ProviderCatalogRequestOptions
): Promise<ProviderCatalogResponse> {
  return request<ProviderCatalogResponse>(providerCatalogPath(options));
}
