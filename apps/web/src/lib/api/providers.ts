import type { ProviderCatalogResponse } from '@simple-agent-manager/shared';

import { request } from './client';

export async function getProviderCatalog(): Promise<ProviderCatalogResponse> {
  return request<ProviderCatalogResponse>('/api/providers/catalog');
}
