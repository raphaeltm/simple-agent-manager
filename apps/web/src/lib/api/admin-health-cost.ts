import type {
  InstallationCloudflareRefreshResponse,
  InstallationHealthRange,
  InstallationHealthResponse,
} from '@simple-agent-manager/shared';

import { request } from './client';

/** Admin Health & cost's one aggregated read (`GET /api/admin/health-cost`), superadmin only. */
export function getInstallationHealth(
  range: InstallationHealthRange,
  signal?: AbortSignal
): Promise<InstallationHealthResponse> {
  return request<InstallationHealthResponse>(
    `/api/admin/health-cost?range=${encodeURIComponent(range)}`,
    { signal }
  );
}

/** Runs the daily Cloudflare cost snapshot now (the card's "Refresh now"), superadmin only. */
export function refreshCloudflareCost(): Promise<InstallationCloudflareRefreshResponse> {
  return request<InstallationCloudflareRefreshResponse>(
    '/api/admin/health-cost/cloudflare/refresh',
    { method: 'POST' }
  );
}
