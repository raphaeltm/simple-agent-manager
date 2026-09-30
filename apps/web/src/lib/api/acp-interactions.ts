import type {
  AcpInteractionBrowserAnswer,
  AcpInteractionSafeSummary,
} from '@simple-agent-manager/shared';

import { request } from './client';

/** Non-creators receive only this structural subset for pending requests. */
export type AcpInteractionSnapshotItem = Partial<AcpInteractionSafeSummary> &
  Pick<AcpInteractionSafeSummary, 'interactionId' | 'kind' | 'state' | 'createdAt' | 'deadlineAt'>;

export interface AcpInteractionSnapshotResponse {
  pending: AcpInteractionSnapshotItem[];
  settled: AcpInteractionSnapshotItem[];
  cursor: string | null;
}

export interface AcpInteractionDetailResponse {
  summary: AcpInteractionSafeSummary;
  detail: Record<string, unknown> | null;
}

export interface AcpInteractionAnswerResponse {
  accepted: true;
  state: AcpInteractionSafeSummary['state'];
}

function interactionBasePath(projectId: string, sessionId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(
    sessionId
  )}/interactions`;
}

export function listAcpInteractions(
  projectId: string,
  sessionId: string
): Promise<AcpInteractionSnapshotResponse> {
  return request(interactionBasePath(projectId, sessionId), { cache: 'no-store' });
}

/**
 * Decrypted detail is deliberately fetched outside TanStack Query so it never
 * enters the app's persistent query cache. The Worker also returns no-store.
 */
export function getAcpInteractionDetail(
  projectId: string,
  sessionId: string,
  interactionId: string,
  signal?: AbortSignal
): Promise<AcpInteractionDetailResponse> {
  return request(
    `${interactionBasePath(projectId, sessionId)}/${encodeURIComponent(interactionId)}`,
    { cache: 'no-store', signal }
  );
}

export function answerAcpInteraction(
  projectId: string,
  sessionId: string,
  interactionId: string,
  body: AcpInteractionBrowserAnswer
): Promise<AcpInteractionAnswerResponse> {
  return request(
    `${interactionBasePath(projectId, sessionId)}/${encodeURIComponent(interactionId)}/answer`,
    {
      method: 'POST',
      cache: 'no-store',
      body: JSON.stringify(body),
    }
  );
}
