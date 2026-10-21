/**
 * Workflow run reads for the Automation pages, through TanStack Query (rule 48: what is on
 * screen stays there while a refresh runs). Runs that are still going refresh on a timer, which
 * TanStack pauses while the tab is hidden; finished runs never change and are not polled.
 */
import type {
  WorkflowRunDetail,
  WorkflowRunListResponse,
  WorkflowRunStatus,
} from '@simple-agent-manager/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useQueryScope } from '../../../hooks/useQueryScope';
import type { WorkflowFilter } from '../../../lib/automation-routes';
import { AUTOMATION_POLL_MS, WORKFLOW_RUN_POLL_MS } from '../../../lib/poll-intervals';
import {
  recentWorkflowRunsQueryOptions,
  workflowRunPagesQueryOptions,
  workflowRunQueryOptions,
} from '../../../lib/query-options';

const hasActiveRun = (response: WorkflowRunListResponse | undefined) =>
  Boolean(response?.runs.some((run) => run.status === 'active'));

// Module scope, typed by the part of the query they read, so every caller shares one function.
function pollWhileListActive(query: { state: { data?: WorkflowRunListResponse } }) {
  return hasActiveRun(query.state.data) ? AUTOMATION_POLL_MS : false;
}
function pollWhilePagesActive(query: { state: { data?: { pages: WorkflowRunListResponse[] } } }) {
  return query.state.data?.pages.some(hasActiveRun) ? AUTOMATION_POLL_MS : false;
}
function pollWhileRunActive(query: { state: { data?: WorkflowRunDetail } }) {
  return query.state.data?.status === 'active' ? WORKFLOW_RUN_POLL_MS : false;
}

/** Every page of the Workflows list loaded so far, flattened, newest first. */
export function useWorkflowRuns(projectId: string, filter: WorkflowFilter) {
  const queryScope = useQueryScope();
  const query = useInfiniteQuery({
    ...workflowRunPagesQueryOptions(queryScope, projectId, filter === 'all' ? null : filter),
    enabled: Boolean(queryScope),
    refetchInterval: pollWhilePagesActive,
  });
  const pages = query.data?.pages;
  const runs = useMemo(() => pages?.flatMap((page) => page.runs) ?? [], [pages]);
  return { query, runs };
}

/** The newest few runs, optionally one status, for the Automation overview. */
export function useRecentWorkflowRuns(
  projectId: string,
  limit: number,
  status: WorkflowRunStatus | null = null
) {
  const queryScope = useQueryScope();
  return useQuery({
    ...recentWorkflowRunsQueryOptions(queryScope, projectId, limit, status),
    enabled: Boolean(queryScope),
    refetchInterval: pollWhileListActive,
  });
}

export function useWorkflowRun(projectId: string, runId: string) {
  const queryScope = useQueryScope();
  return useQuery({
    ...workflowRunQueryOptions(queryScope, projectId, runId),
    enabled: Boolean(queryScope && runId),
    refetchInterval: pollWhileRunActive,
  });
}
