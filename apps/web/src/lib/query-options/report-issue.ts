import { queryOptions } from '@tanstack/react-query';

import { getReportIssueConfig } from '../api';
import { REPORT_ISSUE_CONFIG_STALE_TIME_MS } from '../query-stale-times';

export const reportIssueQueryKeys = {
  config: (queryScope: string) => ['auth', queryScope, 'report-issue', 'config'] as const,
};

/**
 * Whether "Report an issue" is enabled on this deployment.
 *
 * Every chat's tool rail reads it, and the chat view mounts once per session, so
 * it is cached: fetching it per mount would hide the rail's Report action for a
 * round trip — a visible flicker — on every switch between chats.
 */
export function reportIssueConfigQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: reportIssueQueryKeys.config(queryScope),
    queryFn: () => getReportIssueConfig(),
    staleTime: REPORT_ISSUE_CONFIG_STALE_TIME_MS,
  });
}
