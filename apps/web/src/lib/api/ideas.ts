import type {
  IdeaCounts,
  IdeaDerivedStatus,
  IdeaHumanTransition,
  IdeaListItem,
} from '@simple-agent-manager/shared';

import { request } from './client';

/** How many ideas exist in each group, so a capped page can say what it is not showing. */
export interface IdeaListTotals {
  open: number;
  done: number;
  parked: number;
}

export interface IdeasListResponse {
  items: IdeaListItem[];
  truncated: boolean;
  totals: IdeaListTotals;
}

/** One chat linked to an idea, with the task driving it. */
export interface IdeaLinkedSession {
  sessionId: string;
  topic: string | null;
  strong: boolean;
  sessionStatus: string;
  taskId: string | null;
  taskStatus: string | null;
  taskErrorMessage: string | null;
  agentLabel: string | null;
  lastActivityAt: number | null;
  needsInput: { question: string | null; askedAt: number } | null;
}

export interface IdeaDetail {
  ideaId: string;
  title: string;
  /** The current plan, in full, as markdown. */
  content: string | null;
  summary: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  derived: IdeaDerivedStatus;
  counts: IdeaCounts;
  filedByAgent: boolean;
  filedBy: string | null;
  sessions: IdeaLinkedSession[];
  pullRequests: NonNullable<IdeaDerivedStatus['pullRequest']>[];
}

export function listProjectIdeas(
  projectId: string,
  params: { openLimit?: number; closedLimit?: number } = {}
): Promise<IdeasListResponse> {
  const query = new URLSearchParams();
  if (params.openLimit) query.set('openLimit', String(params.openLimit));
  if (params.closedLimit) query.set('closedLimit', String(params.closedLimit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<IdeasListResponse>(`/api/projects/${projectId}/ideas${suffix}`);
}

export function getProjectIdea(projectId: string, ideaId: string): Promise<IdeaDetail> {
  return request<IdeaDetail>(`/api/projects/${projectId}/ideas/${ideaId}`);
}

/** "Mark done", "Park" and "Keep open". Returns the idea with its new derived state. */
export function setProjectIdeaStatus(
  projectId: string,
  ideaId: string,
  status: IdeaHumanTransition
): Promise<IdeaDetail> {
  return request<IdeaDetail>(`/api/projects/${projectId}/ideas/${ideaId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

/**
 * "Keep open": the other answer to "a pull request merged, is this idea done?". Records the
 * decision so the question does not come back; the idea's status does not change.
 */
export function keepProjectIdeaOpen(projectId: string, ideaId: string): Promise<IdeaDetail> {
  return request<IdeaDetail>(`/api/projects/${projectId}/ideas/${ideaId}/keep-open`, {
    method: 'POST',
  });
}

/** File a new idea. Returns it with its derived state, ready to open. */
export function createProjectIdea(
  projectId: string,
  input: { title: string; content?: string }
): Promise<IdeaDetail> {
  return request<IdeaDetail>(`/api/projects/${projectId}/ideas`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
