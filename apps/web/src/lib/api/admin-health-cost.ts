import type {
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
