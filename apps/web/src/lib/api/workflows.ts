import type {
  WorkflowRunDetailResponse,
  WorkflowRunListResponse,
  WorkflowRunStatus,
} from '@simple-agent-manager/shared';

import { request } from './client';

/** Workflow runs of a project, newest first. Any project member can read them. */
export async function listWorkflowRuns(
  projectId: string,
  options: { status?: WorkflowRunStatus | null; cursor?: string | null; limit?: number } = {}
): Promise<WorkflowRunListResponse> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  return request<WorkflowRunListResponse>(
    `/api/projects/${projectId}/workflows${query ? `?${query}` : ''}`
  );
}

export async function getWorkflowRun(
  projectId: string,
  runId: string
): Promise<WorkflowRunDetailResponse> {
  return request<WorkflowRunDetailResponse>(
    `/api/projects/${projectId}/workflows/${encodeURIComponent(runId)}`
  );
}
