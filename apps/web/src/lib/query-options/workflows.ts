/**
 * Query keys and options for workflow runs (project Automation → Workflows).
 *
 * Keys follow the barrel's invariant, `['auth', queryScope, 'workflows', operation, projectId,
 * …]`. None is persisted: runs carry agent-written instructions and summaries.
 */
import type { WorkflowRunStatus } from '@simple-agent-manager/shared';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import { getWorkflowRun, listWorkflowRuns } from '../api';
import { WORKFLOW_RUNS_PAGE_SIZE } from '../automation-config';

const key = (queryScope: string, operation: string, projectId: string) =>
  ['auth', queryScope, 'workflows', operation, projectId] as const;

export const workflowQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'workflows'] as const,
  /** Every page of the Workflows list, optionally one status. */
  runPages: (queryScope: string, projectId: string, status: WorkflowRunStatus | null) =>
    [...key(queryScope, 'run-pages', projectId), status ?? 'all'] as const,
  /** The newest few runs, optionally one status, for the Automation overview. */
  recentRuns: (
    queryScope: string,
    projectId: string,
    limit: number,
    status: WorkflowRunStatus | null
  ) => [...key(queryScope, 'recent-runs', projectId), limit, status ?? 'all'] as const,
  run: (queryScope: string, projectId: string, runId: string) =>
    [...key(queryScope, 'run', projectId), runId] as const,
};

export function workflowRunPagesQueryOptions(
  queryScope: string,
  projectId: string,
  status: WorkflowRunStatus | null
) {
  return infiniteQueryOptions({
    queryKey: workflowQueryKeys.runPages(queryScope, projectId, status),
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      listWorkflowRuns(projectId, {
        status,
        cursor: pageParam || null,
        limit: WORKFLOW_RUNS_PAGE_SIZE,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function recentWorkflowRunsQueryOptions(
  queryScope: string,
  projectId: string,
  limit: number,
  status: WorkflowRunStatus | null = null
) {
  return queryOptions({
    queryKey: workflowQueryKeys.recentRuns(queryScope, projectId, limit, status),
    queryFn: () => listWorkflowRuns(projectId, { limit, status }),
  });
}

export function workflowRunQueryOptions(queryScope: string, projectId: string, runId: string) {
  return queryOptions({
    queryKey: workflowQueryKeys.run(queryScope, projectId, runId),
    queryFn: async () => (await getWorkflowRun(projectId, runId)).run,
  });
}
