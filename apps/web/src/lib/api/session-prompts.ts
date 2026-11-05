import type { PromptDeliveryIntent, TaskAttachment } from '@simple-agent-manager/shared';

import { request } from './client';

/** Pushes an idle session's cleanup deadline out; the next follow-up resumes it. */
export async function resetIdleTimer(
  projectId: string,
  sessionId: string
): Promise<{ cleanupAt: number }> {
  return request<{ cleanupAt: number }>(
    `/api/projects/${projectId}/sessions/${sessionId}/idle-reset`,
    {
      method: 'POST',
    }
  );
}

/**
 * Send a follow-up prompt via the REST API. `steer` asks the server to add it to the
 * agent's running turn; the server falls back to the queue, visibly, when it cannot.
 */
export async function sendFollowUpPrompt(
  projectId: string,
  sessionId: string,
  content: string,
  attachments?: TaskAttachment[],
  deliveryIntent: PromptDeliveryIntent = 'queue'
): Promise<{ status: string; sessionId?: string; message?: string }> {
  return request<{ status: string; sessionId?: string; message?: string }>(
    `/api/projects/${projectId}/sessions/${sessionId}/prompt`,
    {
      method: 'POST',
      body: JSON.stringify({
        content,
        attachments,
        ...(deliveryIntent === 'steer' ? { deliveryIntent } : {}),
      }),
    }
  );
}
