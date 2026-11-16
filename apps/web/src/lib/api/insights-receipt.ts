import type { RunReceipt } from '@simple-agent-manager/shared';

import { request } from './client';

/** The Run receipt for one task (`GET /api/projects/:projectId/tasks/:taskId/receipt`). */
export function getRunReceipt(projectId: string, taskId: string): Promise<RunReceipt> {
  return request<RunReceipt>(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/receipt`
  );
}
