/**
 * The Ideas list and the idea page, with each idea's state derived from its linked work.
 *
 * `idea-status.ts` decides *what* an idea's state is; this module collects the evidence.
 * It is deliberately batched: one read per kind of thing, never one read per idea, so a
 * project with a hundred ideas costs the same number of round trips as one with three
 * (rule 60). The reads are:
 *
 *   1. the open ideas (D1)
 *   2. the recently finished and parked ideas (D1)
 *   3. how many ideas exist in each status, so a capped page can say what it dropped (D1)
 *   4. the chats and unanswered questions linked to all of them (one ProjectData RPC)
 *   5. those chats' tasks (D1)
 *   6. the pull requests recorded against those tasks (D1)
 *   7. the agent profile names for those tasks (D1)
 *   8. the stored state of those pull requests (T2's operation, injected by the caller)
 *
 * Open ideas are read separately from finished ones on purpose. A single
 * `ORDER BY updated_at DESC LIMIT n` ranks by recency, which has nothing to do with what the
 * list is for: a project that shipped two hundred ideas would spend the whole page on them and
 * push the open ones off it (rule 65). Each group is capped on its own and the totals are
 * returned, so the page can say what it is not showing.
 */
import type {
  IdeaCounts,
  IdeaDerivedStatus,
  IdeaListItem,
  IdeaPullRequestSummary,
} from '@simple-agent-manager/shared';

import { log } from '../lib/logger';
import * as projectDataService from '../services/project-data';
import { OperationError } from './errors';
import {
  DEFAULT_IDEA_LIST_CLOSED_LIMIT,
  DEFAULT_IDEA_LIST_OPEN_LIMIT,
  filedByAgent,
  filedByLabel,
  type IdeaListTotals,
  type IdeaRow,
  ideaSummary,
  readAgentProfileNames,
  readAssociatedPullRequests,
  readIdeaRow,
  readIdeaRows,
  readIdeaTotals,
  readSessionTasks,
  type SessionTaskRow,
  viaConnector,
} from './idea-list-reads';
import { deriveIdeaStatus, type IdeaStatusLinkedSession } from './idea-status';
import { clampOperationNumber, getPlatformOperationLimits } from './limits';
import type { OperationContext } from './types';

/**
 * Reads the stored state of pull requests, keyed by URL. Supplied by the caller so pull
 * request state has one implementation with one owner: T2's `getPullRequestStates`
 * (`operations/pull-request-core.ts`). A URL with no stored state maps to `null`, and an idea
 * whose pull requests are all unknown simply cannot reach `review` or `merged`.
 */
export type IdeaPullRequestStateReader = (
  urls: readonly string[]
) => Promise<Record<string, IdeaPullRequestSummary | null>>;

const noPullRequestState: IdeaPullRequestStateReader = async () => ({});

export interface ListIdeasResult {
  items: IdeaListItem[];
  truncated: boolean;
  totals: IdeaListTotals;
}

export interface ListIdeasInput {
  projectId: string;
  openLimit?: number;
  closedLimit?: number;
  readPullRequestStates?: IdeaPullRequestStateReader;
}

export interface IdeaDetailResult {
  ideaId: string;
  title: string;
  /** The current plan, in full. */
  content: string | null;
  summary: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  derived: IdeaDerivedStatus;
  counts: IdeaCounts;
  filedByAgent: boolean;
  filedBy: string | null;
  viaConnector: string | null;
  /** Every chat linked to the idea, newest activity first. */
  sessions: IdeaStatusLinkedSession[];
  /** Every pull request recorded for the idea whose state is known. */
  pullRequests: IdeaPullRequestSummary[];
}

interface IdeaEvidence {
  sessions: IdeaStatusLinkedSession[];
  pullRequests: IdeaPullRequestSummary[];
  pullRequestUrls: string[];
}

function emptyEvidence(): IdeaEvidence {
  return { sessions: [], pullRequests: [], pullRequestUrls: [] };
}

function toLinkedSession(
  session: {
    sessionId: string;
    topic: string | null;
    sessionStatus: string;
    sessionTaskId: string | null;
    lastActivityAt: number | null;
  },
  task: SessionTaskRow | undefined,
  agentLabel: string | null,
  needsInput: { question: string | null; askedAt: number } | null
): IdeaStatusLinkedSession {
  return {
    sessionId: session.sessionId,
    topic: session.topic,
    // Every link that exists today is a strong one: `chat_session_ideas` rows are written only
    // by `link_idea` and by the browser after starting work, both of which mean "this chat
    // works on this idea". T1's generic link store adds weak relations (`read`, `viewed`,
    // `discusses`); at that point this is read from the link row instead of assumed. The
    // derivation already ignores weak links, and a test pins that.
    strong: true,
    sessionStatus: session.sessionStatus,
    taskId: session.sessionTaskId,
    taskStatus: task?.status ?? null,
    taskErrorMessage: task?.error_message ?? null,
    agentLabel,
    lastActivityAt: session.lastActivityAt,
    needsInput,
  };
}

/** Collects the evidence for every idea in `rows`, in a fixed number of round trips. */
async function collectEvidence(
  ctx: OperationContext,
  projectId: string,
  rows: readonly IdeaRow[],
  readPullRequestStates: IdeaPullRequestStateReader
): Promise<Map<string, IdeaEvidence>> {
  const evidence = new Map<string, IdeaEvidence>();
  for (const row of rows) evidence.set(row.id, emptyEvidence());
  if (rows.length === 0) return evidence;

  const snapshots = await projectDataService.getIdeaWorkSnapshots(
    ctx.env,
    projectId,
    rows.map((row) => row.id)
  );

  const sessionTaskIds: string[] = [];
  for (const snapshot of Object.values(snapshots)) {
    for (const session of snapshot.sessions) {
      if (session.sessionTaskId) sessionTaskIds.push(session.sessionTaskId);
    }
  }

  const [tasks, associations] = await Promise.all([
    sessionTaskIds.length > 0
      ? readSessionTasks(ctx, projectId, sessionTaskIds)
      : Promise.resolve(new Map<string, SessionTaskRow>()),
    sessionTaskIds.length > 0
      ? readAssociatedPullRequests(ctx, projectId, sessionTaskIds)
      : Promise.resolve(new Map<string, string[]>()),
  ]);

  const profileIds = [...tasks.values()]
    .map((task) => task.agent_profile_hint)
    .filter((value): value is string => Boolean(value));
  const profileNames =
    profileIds.length > 0
      ? await readAgentProfileNames(ctx, profileIds)
      : new Map<string, string>();

  // Every pull request URL any of these ideas touches, asked for once.
  const allUrls = new Set<string>();
  for (const row of rows) {
    const snapshot = snapshots[row.id];
    const entry = evidence.get(row.id);
    if (!snapshot || !entry) continue;
    const questionBySession = new Map(
      snapshot.needsInput.map((marker) => [marker.sessionId, marker])
    );
    for (const session of snapshot.sessions) {
      const task = session.sessionTaskId ? tasks.get(session.sessionTaskId) : undefined;
      const marker = questionBySession.get(session.sessionId);
      const agentLabel = task?.agent_profile_hint
        ? (profileNames.get(task.agent_profile_hint) ?? null)
        : null;
      entry.sessions.push(
        toLinkedSession(
          session,
          task,
          agentLabel,
          marker ? { question: marker.question, askedAt: marker.askedAt } : null
        )
      );
      const urls = [
        ...(task?.output_pr_url ? [task.output_pr_url] : []),
        ...(session.sessionTaskId ? (associations.get(session.sessionTaskId) ?? []) : []),
      ];
      for (const url of urls) {
        if (!entry.pullRequestUrls.includes(url)) entry.pullRequestUrls.push(url);
        allUrls.add(url);
      }
    }
  }

  if (allUrls.size === 0) return evidence;

  let states: Record<string, IdeaPullRequestSummary | null> = {};
  try {
    states = await readPullRequestStates([...allUrls]);
  } catch (error) {
    // Unknown pull request state degrades the derived status to what the chats alone say.
    // It must never fail the whole list.
    log.warn('ideas.pull_request_state_unavailable', {
      projectId,
      urlCount: allUrls.size,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  for (const entry of evidence.values()) {
    for (const url of entry.pullRequestUrls) {
      const state = states[url];
      if (state) entry.pullRequests.push(state);
    }
  }

  return evidence;
}

function countsFor(entry: IdeaEvidence, updates: number): IdeaCounts {
  return {
    updates,
    chats: entry.sessions.length,
    // Files arrive with T1's link store; until then an idea has no file links to count.
    files: 0,
    pullRequests: entry.pullRequestUrls.length,
  };
}

function derivedFor(row: IdeaRow, entry: IdeaEvidence): IdeaDerivedStatus {
  return deriveIdeaStatus({
    ideaStatus: row.status,
    ideaUpdatedAt: row.updated_at,
    mergeAcknowledgedAt: row.idea_merge_ack_at,
    sessions: entry.sessions,
    pullRequests: entry.pullRequests,
  });
}

export async function listIdeasWithDerivedStatus(
  ctx: OperationContext,
  input: ListIdeasInput
): Promise<ListIdeasResult> {
  const limits = getPlatformOperationLimits(ctx.env);
  const openLimit = clampOperationNumber(
    input.openLimit ?? DEFAULT_IDEA_LIST_OPEN_LIMIT,
    1,
    limits.ideaListMax,
    'openLimit'
  );
  const closedLimit = clampOperationNumber(
    input.closedLimit ?? DEFAULT_IDEA_LIST_CLOSED_LIMIT,
    1,
    limits.ideaListMax,
    'closedLimit'
  );

  const [openRows, closedRows, totals] = await Promise.all([
    readIdeaRows(ctx, input.projectId, true, openLimit),
    readIdeaRows(ctx, input.projectId, false, closedLimit),
    readIdeaTotals(ctx, input.projectId),
  ]);
  const truncated = openRows.length > openLimit || closedRows.length > closedLimit;
  const rows = [...openRows.slice(0, openLimit), ...closedRows.slice(0, closedLimit)];

  const evidence = await collectEvidence(
    ctx,
    input.projectId,
    rows,
    input.readPullRequestStates ?? noPullRequestState
  );

  const items = rows.map((row) => {
    const entry = evidence.get(row.id) ?? emptyEvidence();
    return {
      ideaId: row.id,
      title: row.title,
      summary: ideaSummary(row.description),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      derived: derivedFor(row, entry),
      counts: countsFor(entry, 0),
      filedByAgent: filedByAgent(row),
      filedBy: filedByLabel(row),
      viaConnector: viaConnector(row),
    } satisfies IdeaListItem;
  });
  return { items, truncated, totals };
}

export interface GetIdeaInput {
  projectId: string;
  ideaId: string;
  readPullRequestStates?: IdeaPullRequestStateReader;
}

export async function getIdeaWithDerivedStatus(
  ctx: OperationContext,
  input: GetIdeaInput
): Promise<IdeaDetailResult> {
  const ideaId = typeof input.ideaId === 'string' ? input.ideaId.trim() : '';
  if (!ideaId) throw new OperationError('invalid_input', 'ideaId is required');
  const row = await readIdeaRow(ctx, input.projectId, ideaId);
  if (!row) throw new OperationError('not_found', `Idea not found in this project: ${ideaId}`);

  const evidence = await collectEvidence(
    ctx,
    input.projectId,
    [row],
    input.readPullRequestStates ?? noPullRequestState
  );
  const entry = evidence.get(row.id) ?? emptyEvidence();

  return {
    ideaId: row.id,
    title: row.title,
    content: row.description,
    summary: ideaSummary(row.description),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    derived: derivedFor(row, entry),
    counts: countsFor(entry, 0),
    filedByAgent: filedByAgent(row),
    filedBy: filedByLabel(row),
    viaConnector: viaConnector(row),
    sessions: entry.sessions,
    pullRequests: entry.pullRequests,
  };
}
