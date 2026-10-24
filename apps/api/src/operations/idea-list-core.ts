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
 *   4. the link caps, and the project's repository (admin settings, D1)
 *   5. the chats, questions, files, pull requests and note counts linked to all of them
 *      (one ProjectData RPC, which reads the link store through T1's links module)
 *   6. those chats' tasks (D1)
 *   7. the pull requests recorded against those tasks (D1)
 *   8. the agent profile names for those tasks (D1)
 *   9. the stored state of every pull request found (T2's `getPullRequestStates`)
 *
 * Open ideas are read separately from finished ones on purpose. A single
 * `ORDER BY updated_at DESC LIMIT n` ranks by recency, which has nothing to do with what the
 * list is for: a project that shipped two hundred ideas would spend the whole page on them and
 * push the open ones off it (rule 65). Each group is capped on its own and the totals are
 * returned, so the page can say what it is not showing.
 */
import type {
  IdeaCountKind,
  IdeaCounts,
  IdeaDerivedStatus,
  IdeaListItem,
  IdeaPullRequest,
  PullRequestRef,
} from '@simple-agent-manager/shared';
import type { LinkRelation } from '@simple-agent-manager/shared';

import type { IdeaWorkSnapshot } from '../durable-objects/project-data/idea-work';
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
  readProjectRepository,
  readSessionTasks,
  type SessionTaskRow,
  viaConnector,
} from './idea-list-reads';
import { deriveIdeaStatus, type IdeaStatusLinkedSession } from './idea-status';
import { clampOperationNumber, getPlatformOperationLimits } from './limits';
import { canonicalPullRequestRefs, resolveResourceLinkBatchCaps } from './link-core';
import { getPullRequestStates } from './pull-request-core';
import type { OperationContext } from './types';

/**
 * Whether this read may ask GitHub for pull request state it has not stored.
 *
 * `'none'` reads what T2 has stored and nothing else. `'single'` lets T2 schedule one bounded
 * background refresh through `ctx.execCtx.waitUntil` (program decision 4) — only the
 * single-idea read uses it, because a whole list page would be one GitHub call per pull
 * request in the project.
 */
export type IdeaPullRequestRefresh = 'none' | 'single';

export interface ListIdeasResult {
  items: IdeaListItem[];
  truncated: boolean;
  totals: IdeaListTotals;
}

export interface ListIdeasInput {
  projectId: string;
  openLimit?: number;
  closedLimit?: number;
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
  pullRequests: IdeaPullRequest[];
}

interface IdeaEvidence {
  sessions: IdeaStatusLinkedSession[];
  pullRequests: IdeaPullRequest[];
  pullRequestRefs: PullRequestRef[];
}

function emptyEvidence(): IdeaEvidence {
  return { sessions: [], pullRequests: [], pullRequestRefs: [] };
}

function toLinkedSession(
  session: {
    sessionId: string;
    topic: string | null;
    sessionStatus: string;
    sessionTaskId: string | null;
    lastActivityAt: number | null;
    relations: LinkRelation[];
    strong: boolean;
  },
  task: SessionTaskRow | undefined,
  agentLabel: string | null,
  needsInput: { question: string | null; askedAt: number } | null
): IdeaStatusLinkedSession {
  return {
    sessionId: session.sessionId,
    topic: session.topic,
    // Strength comes from the link rows themselves. Before T1's link store every link meant
    // "works on", so this could be assumed; now a chat that only read or discussed an idea
    // is linked to it too, and must not be able to move it (the program's strength rules).
    relations: session.relations,
    strong: session.strong,
    sessionStatus: session.sessionStatus,
    taskId: session.sessionTaskId,
    taskStatus: task?.status ?? null,
    taskErrorMessage: task?.error_message ?? null,
    agentLabel,
    lastActivityAt: session.lastActivityAt,
    needsInput,
  };
}

interface CollectedEvidence {
  evidence: Map<string, IdeaEvidence>;
  /** The raw link snapshots, which carry the counts and what a cap truncated. */
  snapshots: Record<string, IdeaWorkSnapshot>;
}

/** Collects the evidence for every idea in `rows`, in a fixed number of round trips. */
async function collectEvidence(
  ctx: OperationContext,
  projectId: string,
  rows: readonly IdeaRow[],
  refresh: IdeaPullRequestRefresh
): Promise<CollectedEvidence> {
  const evidence = new Map<string, IdeaEvidence>();
  for (const row of rows) evidence.set(row.id, emptyEvidence());
  if (rows.length === 0) return { evidence, snapshots: {} };

  const [caps, repository] = await Promise.all([
    resolveResourceLinkBatchCaps(ctx.env),
    readProjectRepository(ctx, projectId),
  ]);

  const snapshots = await projectDataService.getIdeaWorkSnapshots(
    ctx.env,
    projectId,
    rows.map((row) => row.id),
    caps
  );

  const sessionTaskIds: string[] = [];
  for (const snapshot of Object.values(snapshots)) {
    for (const session of snapshot.sessions) {
      if (session.strong && session.sessionTaskId) sessionTaskIds.push(session.sessionTaskId);
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
  const allRefs = new Map<string, PullRequestRef>();
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
    }
    // What the idea owns: pull requests its strong chats' tasks produced, and the ones the
    // link store records against the idea or those chats. A weak link contributes nothing.
    const strongTaskIds = new Set(
      snapshot.sessions
        .filter((session) => session.strong && session.sessionTaskId)
        .map((session) => session.sessionTaskId as string)
    );
    const candidates: Array<{ url: string; source: PullRequestRef['source'] }> = [];
    for (const taskId of strongTaskIds) {
      const task = tasks.get(taskId);
      if (task?.output_pr_url) candidates.push({ url: task.output_pr_url, source: 'task_output' });
      for (const url of associations.get(taskId) ?? [])
        candidates.push({ url, source: 'pr_association' });
    }
    for (const url of snapshot.pullRequestUrls) candidates.push({ url, source: 'explicit_link' });
    // The same canonicalize-and-collapse the single-resource context reads use, so an idea's
    // pull requests are the same set whichever page asked (program decision 3).
    for (const ref of canonicalPullRequestRefs(candidates, repository)) {
      entry.pullRequestRefs.push(ref);
      if (!allRefs.has(ref.url)) allRefs.set(ref.url, ref);
    }
  }

  if (allRefs.size === 0) return { evidence, snapshots };

  let states: Awaited<ReturnType<typeof getPullRequestStates>> = {};
  try {
    states = await getPullRequestStates(ctx, projectId, [...allRefs.values()], {
      // The repository is already in hand from `readProjectRepository`, so this does not
      // re-read the same one-row `projects` lookup (rule 60).
      repository,
      ...(refresh === 'single' ? { refresh: 'single' as const } : {}),
    });
  } catch (error) {
    // Unknown pull request state degrades the derived status to what the chats alone say.
    // It must never fail the whole list.
    log.warn('ideas.pull_request_state_unavailable', {
      projectId,
      urlCount: allRefs.size,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  for (const entry of evidence.values()) {
    for (const ref of entry.pullRequestRefs) {
      const state = states[ref.url];
      if (state) entry.pullRequests.push({ ...ref, ...state });
    }
  }

  return { evidence, snapshots };
}

function countsFor(entry: IdeaEvidence, snapshot: IdeaWorkSnapshot | undefined): IdeaCounts {
  const atLeast: IdeaCountKind[] = [];
  if (snapshot?.truncated.sessions) atLeast.push('chats');
  if (snapshot?.truncated.files) atLeast.push('files');
  if (snapshot?.truncated.pullRequests) atLeast.push('pullRequests');
  return {
    updates: snapshot?.updates ?? 0,
    chats: entry.sessions.length,
    files: snapshot?.fileIds.length ?? 0,
    pullRequests: entry.pullRequestRefs.length,
    atLeast,
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

  const { evidence, snapshots } = await collectEvidence(ctx, input.projectId, rows, 'none');

  const items = rows.map((row) => {
    const entry = evidence.get(row.id) ?? emptyEvidence();
    return {
      ideaId: row.id,
      title: row.title,
      summary: ideaSummary(row.description),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      derived: derivedFor(row, entry),
      counts: countsFor(entry, snapshots[row.id]),
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
  /** Defaults to `'none'`; the single-idea route passes `'single'`. */
  refresh?: IdeaPullRequestRefresh;
}

export async function getIdeaWithDerivedStatus(
  ctx: OperationContext,
  input: GetIdeaInput
): Promise<IdeaDetailResult> {
  const ideaId = typeof input.ideaId === 'string' ? input.ideaId.trim() : '';
  if (!ideaId) throw new OperationError('invalid_input', 'ideaId is required');
  const row = await readIdeaRow(ctx, input.projectId, ideaId);
  if (!row) throw new OperationError('not_found', `Idea not found in this project: ${ideaId}`);

  const { evidence, snapshots } = await collectEvidence(
    ctx,
    input.projectId,
    [row],
    input.refresh ?? 'none'
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
    counts: countsFor(entry, snapshots[row.id]),
    filedByAgent: filedByAgent(row),
    filedBy: filedByLabel(row),
    viaConnector: viaConnector(row),
    sessions: entry.sessions,
    pullRequests: entry.pullRequests,
  };
}
