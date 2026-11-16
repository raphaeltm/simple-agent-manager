import type { ProjectOverviewResponse } from '@simple-agent-manager/shared';

import { request } from './client';

/** The Project Overview's one aggregated read (`GET /api/projects/:projectId/overview`). */
export function getProjectOverview(projectId: string): Promise<ProjectOverviewResponse> {
  return request<ProjectOverviewResponse>(`/api/projects/${projectId}/overview`);
}
