/**
 * The two reads the idea page needs from the rest of the Linked work program.
 *
 * Updates is T3's contract (idea 01M5NG5WNQAX5026M9SPV9PZE8), merged in #2427, so its types
 * come from `@simple-agent-manager/shared` like any other shared type.
 *
 * `IdeaContext` and the `/links` endpoint are T1's (idea 01M5NG4ZJAD6AZ1YSD1TA676WE) and are
 * not on `main` yet. A branch may not import a type that exists only on another unmerged
 * branch, so the shape announced on `feature.linked-work` is carried below and deleted in
 * favour of `@simple-agent-manager/shared` `types/links.ts` when T1 lands. Until then the
 * idea page's Related section has nothing to read, which is why T8 does not merge first.
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

// ---------------------------------------------------------------------------
// T1 — what else is linked to the idea
// ---------------------------------------------------------------------------

export type LinkRelation =
  | 'created'
  | 'edited'
  | 'read'
  | 'works_on'
  | 'discusses'
  | 'linked'
  | 'uploaded'
  | 'replaced'
  | 'viewed'
  | 'opened'
  | 'related';

export interface CappedList<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

export interface LinkedIdea {
  ideaId: string;
  title: string;
  status: string;
  relations: LinkRelation[];
}

export interface LinkedFile {
  fileId: string;
  filename: string;
  directory: string;
  relations: LinkRelation[];
  bySessionId: string | null;
}

export interface LinkedSession {
  sessionId: string;
  topic: string | null;
  status: string;
  relations: LinkRelation[];
  lastActivityAt: number | null;
  taskId: string | null;
}

export interface LinkedPullRequest {
  url: string;
  number: number;
  source: 'task_output' | 'pr_association' | 'explicit_link';
  bySessionId: string | null;
}

export interface IdeaContext {
  sessions: CappedList<LinkedSession>;
  files: CappedList<LinkedFile>;
  pullRequests: CappedList<LinkedPullRequest>;
  relatedIdeas: CappedList<LinkedIdea>;
}

export function getIdeaLinks(projectId: string, ideaId: string): Promise<IdeaContext> {
  return request<IdeaContext>(`/api/projects/${projectId}/ideas/${ideaId}/links`);
}
