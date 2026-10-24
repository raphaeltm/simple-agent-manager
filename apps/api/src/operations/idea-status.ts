/**
 * Derives where an idea stands from the work linked to it.
 *
 * This module is pure: it takes the idea row's own status, the sessions strongly linked to it
 * (with their tasks and their unanswered questions) and the pull requests for those sessions,
 * and returns one state plus the evidence that decided it. The batched reads that collect that
 * input live in `idea-list-core.ts`; keeping them apart is what lets every precedence rule be
 * tested as a table, and what keeps the list's query count independent of the idea count.
 *
 * Precedence (highest first), from the approved design:
 *
 *   1. `done` / `parked`      the idea row is `completed` / `cancelled` — human decisions
 *   2. `question`             a linked chat has an unanswered question
 *   3. `stuck`                the latest linked work failed and nothing is active
 *   4. `working`              linked work is active
 *   5. `review`               an open pull request and nothing active
 *   6. `merged`               a merged pull request, none open, nothing active, not done
 *   7. `not-started`          nothing above applies
 *
 * Every rule reads the condition itself rather than something correlated with it (rule 74): a
 * chat is working because its task is live or sleeping, not because it was touched recently;
 * an idea is in review because a pull request is open, not because a branch exists.
 *
 * Only *strongly* linked sessions count. A session that merely read or discussed an idea
 * (`read`, `viewed`, `discusses`) must never move it — see the program's strength rules.
 */
import type {
  IdeaDerivedState,
  IdeaDerivedStatus,
  IdeaNeedsYouState,
  IdeaPullRequest,
  IdeaStatusSession,
  IdeaStatusSource,
  LinkRelation,
} from '@simple-agent-manager/shared';
import { ideaNeedsYou } from '@simple-agent-manager/shared';

import { LIVE_TASK_STATUSES, SLEEPING_TASK_STATUSES } from '../services/task-status';

/** How much of an agent's question or failure message travels with the status. */
export const DEFAULT_IDEA_STATUS_NOTE_MAX_LENGTH = 280;

/**
 * A session linked to an idea, as the aggregation reads it.
 *
 * `lastActivityAt` and `needsInput.askedAt` are epoch milliseconds, because that is what the
 * ProjectData Durable Object stores; the derived status converts them to ISO strings.
 */
export interface IdeaStatusLinkedSession {
  sessionId: string;
  topic: string | null;
  /** Every relation recorded between the idea and this chat. */
  relations: LinkRelation[];
  /** True when at least one of those relations is a strong one. */
  strong: boolean;
  /** The chat session's own status (`active`, `sleeping`, `stopped`, …). */
  sessionStatus: string;
  taskId: string | null;
  /** The task's status, or null when the chat has no task. */
  taskStatus: string | null;
  /** What the task reported when it failed. */
  taskErrorMessage: string | null;
  /** An agent profile name, when one is known for the task. */
  agentLabel: string | null;
  lastActivityAt: number | null;
  /** An unresolved attention marker asking a person something. */
  needsInput: { question: string | null; askedAt: number } | null;
}

export interface IdeaStatusInput {
  /** The idea row's own status: `draft`/`ready` open, `completed` done, `cancelled` parked. */
  ideaStatus: string;
  /** Fallback timestamp for `not-started`, so the source always names a time. ISO 8601. */
  ideaUpdatedAt: string;
  /**
   * When a person last chose "Keep open" in answer to the merged question. A merge that is
   * not newer than this has been answered, so it must not ask again. ISO 8601 or null.
   */
  mergeAcknowledgedAt?: string | null;
  sessions: readonly IdeaStatusLinkedSession[];
  pullRequests: readonly IdeaPullRequest[];
}

/**
 * A task that still holds or will reclaim a runtime. A sleeping task has released its runtime
 * but keeps its identity and can be woken, so from the idea's point of view the work has not
 * finished — it is still in progress.
 */
const ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set([
  ...LIVE_TASK_STATUSES,
  ...SLEEPING_TASK_STATUSES,
]);

/** Work is active when its task can still run, or when a task-less chat is still open. */
export function isLinkedWorkActive(session: IdeaStatusLinkedSession): boolean {
  if (session.taskStatus) return ACTIVE_TASK_STATUSES.has(session.taskStatus);
  return session.sessionStatus === 'active';
}

/**
 * Work failed only when its task failed. A cancelled task was stopped on purpose, so it does
 * not ask anyone for anything.
 */
function hasLinkedWorkFailed(session: IdeaStatusLinkedSession): boolean {
  return session.taskStatus === 'failed';
}

function truncateNote(value: string | null, max = DEFAULT_IDEA_STATUS_NOTE_MAX_LENGTH) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function toIso(epochMs: number | null): string | null {
  if (epochMs === null || !Number.isFinite(epochMs)) return null;
  return new Date(epochMs).toISOString();
}

function toStatusSession(session: IdeaStatusLinkedSession): IdeaStatusSession {
  return {
    sessionId: session.sessionId,
    topic: session.topic,
    sessionStatus: session.sessionStatus,
    taskId: session.taskId,
    taskStatus: session.taskStatus,
    agentLabel: session.agentLabel,
    lastActivityAt: toIso(session.lastActivityAt),
  };
}

/** Most recent first, with sessions that have never reported activity last. */
function byActivityDesc(a: IdeaStatusLinkedSession, b: IdeaStatusLinkedSession): number {
  return (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1);
}

function source(
  origin: IdeaStatusSource['origin'],
  observedAt: string | null,
  stale = false
): IdeaStatusSource {
  return { origin, observedAt, stale };
}

function status(
  state: IdeaDerivedState,
  statusSource: IdeaStatusSource,
  extra: {
    session?: IdeaStatusSession | null;
    pullRequest?: IdeaPullRequest | null;
    note?: string | null;
  } = {}
): IdeaDerivedStatus {
  return {
    state,
    needsYou: ideaNeedsYou(state) ? (state as IdeaNeedsYouState) : null,
    source: statusSource,
    session: extra.session ?? null,
    pullRequest: extra.pullRequest ?? null,
    note: extra.note ?? null,
  };
}

/** The newest merged pull request, by merge time. */
function newestMerged(
  pullRequests: readonly IdeaPullRequest[]
): IdeaPullRequest | null {
  const merged = pullRequests.filter((pr) => pr.state === 'merged');
  if (merged.length === 0) return null;
  return merged.reduce((best, pr) => ((pr.mergedAt ?? '') > (best.mergedAt ?? '') ? pr : best));
}

/**
 * True when a person has already answered the merged question for this pull request.
 *
 * A merge with no timestamp is treated as unanswered: that is the fail-open direction, and it
 * asks a question rather than silently swallowing one.
 */
function isMergeAnswered(
  merged: IdeaPullRequest,
  acknowledgedAt: string | null | undefined
): boolean {
  if (!acknowledgedAt) return false;
  if (!merged.mergedAt) return false;
  return new Date(merged.mergedAt).getTime() <= new Date(acknowledgedAt).getTime();
}

/** A ready-for-review pull request wins over a draft, which wins over nothing. */
function bestOpen(pullRequests: readonly IdeaPullRequest[]): IdeaPullRequest | null {
  const open = pullRequests.filter((pr) => pr.state === 'open');
  if (open.length === 0) return null;
  return open.find((pr) => !pr.isDraft) ?? open[0] ?? null;
}

export function deriveIdeaStatus(input: IdeaStatusInput): IdeaDerivedStatus {
  // 1. Human decisions outrank everything. A merged pull request does not finish an idea; a
  //    person saying so does.
  if (input.ideaStatus === 'completed') {
    return status('done', source('person', input.ideaUpdatedAt), {
      pullRequest: newestMerged(input.pullRequests),
    });
  }
  if (input.ideaStatus === 'cancelled') {
    return status('parked', source('person', input.ideaUpdatedAt));
  }

  const linked = input.sessions.filter((session) => session.strong);
  const byActivity = [...linked].sort(byActivityDesc);

  // 2. An unanswered question. The newest one wins, because that is the one on screen.
  const asking = linked
    .filter((session) => session.needsInput !== null)
    .sort((a, b) => (b.needsInput?.askedAt ?? 0) - (a.needsInput?.askedAt ?? 0))[0];
  if (asking?.needsInput) {
    return status('question', source('agent', toIso(asking.needsInput.askedAt)), {
      session: toStatusSession(asking),
      note: truncateNote(asking.needsInput.question),
    });
  }

  const active = byActivity.find(isLinkedWorkActive) ?? null;

  // 3. The latest work failed and nothing is running.
  if (!active) {
    const latest = byActivity.find((session) => session.taskId !== null);
    if (latest && hasLinkedWorkFailed(latest)) {
      return status('stuck', source('chat', toIso(latest.lastActivityAt)), {
        session: toStatusSession(latest),
        note: truncateNote(latest.taskErrorMessage),
      });
    }
  }

  // 4. Work is running (or sleeping, and will wake).
  if (active) {
    return status('working', source('chat', toIso(active.lastActivityAt)), {
      session: toStatusSession(active),
    });
  }

  // 5. A pull request is open. A draft counts: it is still the thing to look at.
  const open = bestOpen(input.pullRequests);
  if (open) {
    return status('review', source('github', open.updatedAt, open.stale), { pullRequest: open });
  }

  // 6. A pull request merged, and nobody has said whether that finished the idea. Asking
  //    once is the design; asking every time the page loads is not, so a merge a person has
  //    already answered with "Keep open" stops asking. The acknowledgement is its own column
  //    rather than the row's `updated_at`, because an agent's note moves `updated_at` and
  //    must not be able to answer a question that was put to a person (rule 74).
  const merged = newestMerged(input.pullRequests);
  if (merged && !isMergeAnswered(merged, input.mergeAcknowledgedAt)) {
    return status('merged', source('github', merged.mergedAt ?? merged.updatedAt, merged.stale), {
      pullRequest: merged,
    });
  }

  // 7. Nothing above applies. This is the fallback, so it also covers an idea whose only
  //    linked work finished without opening a pull request: there is nothing in flight and
  //    nothing to review, and the row's own summary says what was learned.
  return status('not-started', source(linked.length > 0 ? 'chat' : 'none', input.ideaUpdatedAt));
}
