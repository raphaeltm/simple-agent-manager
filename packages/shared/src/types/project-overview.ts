/**
 * The Project Overview page's one aggregated read (`GET /api/projects/:projectId/overview`,
 * operation `projectOverviewGet` in `packages/operations/src/project-overview.ts`).
 *
 * Inbox slice F1 (idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9, section 4.2). Later slices add fields
 * (Needs you, the brief) beside these; existing fields keep their meaning.
 */
import type { IdeaListItem } from './ideas';

/** Running chats the read returns by default; the page shows these and says how many more. */
export const DEFAULT_PROJECT_OVERVIEW_RUNNING_LIMIT = 5;
/** Ideas and merged pull requests the read returns by default, each. */
export const DEFAULT_PROJECT_OVERVIEW_RECENT_LIMIT = 3;
/** The most any caller may ask for in one section. */
export const MAX_PROJECT_OVERVIEW_LIMIT = 20;

/** A section of the read that can fail on its own without failing the page. */
export type ProjectOverviewSection = 'running' | 'ideas' | 'pullRequests';

/**
 * What a running chat is doing, from the records SAM acts on:
 * - `starting`: its task is still being placed or provisioned (queued, delegated).
 * - `working`: the agent is mid-turn.
 * - `waiting`: the agent asked a question and the chat is paused on the answer.
 */
export type OverviewRunningState = 'starting' | 'working' | 'waiting';

export interface OverviewRunningChat {
  sessionId: string;
  taskId: string | null;
  /** The chat's topic; null until the first message names it. Untrusted text. */
  topic: string | null;
  state: OverviewRunningState;
  /** True when the open question is the viewer's to answer (they started the chat). */
  waitingOnViewer: boolean;
  /** Epoch ms the chat started; the row's "how long". */
  startedAt: number;
  /** Epoch ms of the latest message, or the start when there is none. */
  lastActivityAt: number;
  /** The profile the chat runs with; null when it ran without one or it was deleted. */
  profile: { id: string; name: string } | null;
  createdByUserId: string | null;
}

export interface OverviewMergedPullRequest {
  number: number;
  /** The pull request on GitHub (or the project's repository host). */
  url: string;
  title: string | null;
  repository: string;
  /** ISO timestamp; null when the host did not report one. */
  mergedAt: string | null;
}

export interface ProjectOverviewResponse {
  projectId: string;
  running: {
    /** Chats waiting on the viewer first, then newest activity first; at most the read's limit. */
    items: OverviewRunningChat[];
    /** Every running chat in the project, including those past the limit. */
    total: number;
    /**
     * Running chats paused on a question for the viewer, including those past the limit. Those
     * rows are ranked first, so a page can say how many the cap still hid.
     */
    waitingOnViewerTotal: number;
  };
  recent: {
    /** The most recently updated ideas, open or closed. */
    ideas: IdeaListItem[];
    /** The most recently merged pull requests. */
    mergedPullRequests: OverviewMergedPullRequest[];
  };
  /** Sections whose read failed this time; they are empty, not "nothing here". */
  unavailable: ProjectOverviewSection[];
  /** ISO timestamp of the read. */
  generatedAt: string;
}
