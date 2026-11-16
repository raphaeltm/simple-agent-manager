/**
 * Query key and options for a task's Run receipt (Insights slice R).
 *
 * Keyed `['auth', queryScope, 'run-receipt', projectId, taskId]` like every authenticated query.
 * Not persisted. A live run is refreshed on `RUN_RECEIPT_POLL_MS` (paused on a hidden tab); a
 * finished run is final, so it is not polled.
 */
import { queryOptions } from '@tanstack/react-query';

import { getRunReceipt } from '../api';
import { RUN_RECEIPT_POLL_MS } from '../poll-intervals';

export const runReceiptQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'run-receipt'] as const,
  detail: (queryScope: string, projectId: string, taskId: string) =>
    [...runReceiptQueryKeys.all(queryScope), projectId, taskId] as const,
};

export function runReceiptQueryOptions(queryScope: string, projectId: string, taskId: string) {
  return queryOptions({
    queryKey: runReceiptQueryKeys.detail(queryScope, projectId, taskId),
    queryFn: () => getRunReceipt(projectId, taskId),
    refetchInterval: (query) => (query.state.data?.live ? RUN_RECEIPT_POLL_MS : false),
  });
}
