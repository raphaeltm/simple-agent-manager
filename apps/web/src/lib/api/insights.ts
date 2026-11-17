import type {
  InsightsRange,
  ProjectAccountsResponse,
  ProjectFlowResponse,
  ProjectPeopleResponse,
} from '@simple-agent-manager/shared';

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

/** Insights · Accounts for one project (`GET /api/projects/:projectId/insights/accounts`). */
export function getProjectAccounts(
  projectId: string,
  range: InsightsRange
): Promise<ProjectAccountsResponse> {
  return request<ProjectAccountsResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/insights/accounts?range=${range}`
  );
}

/** Insights · People for one project (`GET /api/projects/:projectId/insights/people`). */
export function getProjectPeople(
  projectId: string,
  range: InsightsRange
): Promise<ProjectPeopleResponse> {
  return request<ProjectPeopleResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/insights/people?range=${range}`
  );
}
