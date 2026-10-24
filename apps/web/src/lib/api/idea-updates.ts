/**
 * The idea's updates timeline (T3's contract, idea 01M5NG5WNQAX5026M9SPV9PZE8, merged in
 * #2427), so its types come from `@simple-agent-manager/shared` like any other shared type.
 *
 * What else is linked to an idea is NOT here. This file briefly carried a hand-copied
 * `IdeaContext` and its own `getIdeaLinks`, because T1's endpoint existed only on an unmerged
 * branch and a branch may not import a type from another branch. T1 and T4 have both landed,
 * so the real ones live in `api/links.ts` over `@simple-agent-manager/shared` `types/links.ts`
 * and the copy is gone — keeping it would have left the page reading a shape that had already
 * drifted (the copy had no `totalIsLowerBound`).
 */
import type { IdeaUpdateNote, IdeaUpdatesPage } from '@simple-agent-manager/shared';

import { request } from './client';

export type { IdeaUpdateNote, IdeaUpdatesPage };

// ---------------------------------------------------------------------------
// T3 — the updates timeline
// ---------------------------------------------------------------------------

export function listIdeaUpdates(
  projectId: string,
  ideaId: string,
  cursor?: string
): Promise<IdeaUpdatesPage> {
  const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return request<IdeaUpdatesPage>(`/api/projects/${projectId}/ideas/${ideaId}/updates${suffix}`);
}

export function postIdeaUpdate(
  projectId: string,
  ideaId: string,
  input: { body: string; quote?: string }
): Promise<{ update: IdeaUpdateNote }> {
  return request<{ update: IdeaUpdateNote }>(`/api/projects/${projectId}/ideas/${ideaId}/updates`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
