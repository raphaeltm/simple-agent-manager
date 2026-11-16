import type { InsightsRange, ProjectFlowResponse } from '@simple-agent-manager/shared';

import { request } from './client';

/** Insights · Flow for one project (`GET /api/projects/:projectId/insights/flow`). */
export function getProjectFlow(
  projectId: string,
  range: InsightsRange
): Promise<ProjectFlowResponse> {
  return request<ProjectFlowResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/insights/flow?range=${range}`
  );
}
