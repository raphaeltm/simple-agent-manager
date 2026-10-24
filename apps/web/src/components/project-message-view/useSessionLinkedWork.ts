/**
 * One owner for "what is this chat related to".
 *
 * The header chip, the tool rail's Related badge and the Related panel all read this. It is
 * called once, in `SessionMessageView`, and threaded down — rather than called in each place —
 * so there is a single derivation of "the idea being worked on" and "the PR this chat opened",
 * and a single memoised object identity for the three consumers (rule 64: an object rebuilt
 * during render remounts the subtree it is passed to).
 *
 * Stale-while-revalidate: `isLoading` is true only before the first result. A refetch leaves
 * the previous lists in place, so nothing the user is looking at unmounts
 * (`apps/web/.claude/rules/48-stale-while-revalidate-ui.md`).
 */
import type {
  CappedList,
  LinkedFile,
  LinkedIdea,
  LinkedPullRequest,
  PullRequestState,
} from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { emptyCappedList } from '../../lib/api/links';
import { sessionLinksQueryOptions } from '../../lib/query-options';

/** How the header chip introduces the idea. `works_on` is the stronger claim, so it wins. */
export interface SessionWorkingOnIdea {
  idea: LinkedIdea;
  verb: 'Working on' | 'Discussing';
}

/**
 * The pull request the chat header points at.
 *
 * `number` and `state` are both optional because the header must keep working for a URL SAM
 * cannot parse or has not recorded — a GitLab merge request, a pull request on another host,
 * or one whose state has not been read yet. Dropping the link in those cases would hide work
 * the header used to show.
 */
export interface HeaderPullRequest {
  url: string;
  number: number | null;
  state: PullRequestState | null;
}

export interface SessionLinkedWork {
  ideas: CappedList<LinkedIdea>;
  files: CappedList<LinkedFile>;
  pullRequests: CappedList<LinkedPullRequest>;
  /** The idea this chat works on, or merely discusses, for the header chip. */
  workingOn: SessionWorkingOnIdea | null;
  /** The pull request the header links to, carrying its number and state when known. */
  primaryPullRequest: HeaderPullRequest | null;
  /** Everything linked, for the rail badge. */
  totalCount: number;
  /** True when any of the three lists could only report a minimum — the badge shows "N+". */
  totalIsLowerBound: boolean;
  /** True only before the first result; never during a refetch. */
  isLoading: boolean;
  /** True only when there is no data to fall back on. */
  isError: boolean;
  refetch: () => void;
}

/** `https://github.com/owner/repo/pull/123` → `123`. */
export function pullRequestNumberFromUrl(url: string | null | undefined): number | null {
  const match = url ? /\/pull\/(\d+)(?:\/)?$/.exec(url) : null;
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The PR the chat header should point at.
 *
 * Matching on the NUMBER rather than on `source === 'task_output'`: the same PR can arrive from
 * the task's output URL, a shepherd association and an explicit link, and the server collapses
 * duplicates to whichever source it saw first — so the surviving row for the task's own PR is
 * not reliably labelled `task_output`.
 *
 * When the task records no PR but the link store knows one (a PR a shepherd associated, or one
 * an agent linked explicitly), that one is used, so the header stops being blank about work
 * that exists.
 */
export function resolvePrimaryPullRequest(
  outputPrUrl: string | null | undefined,
  pullRequests: readonly LinkedPullRequest[]
): HeaderPullRequest | null {
  if (outputPrUrl) {
    const number = pullRequestNumberFromUrl(outputPrUrl);
    // Match on the NUMBER, not on `source === 'task_output'`: the same PR can arrive from the
    // task's output URL, a shepherd association and an explicit link, and the server collapses
    // duplicates to whichever source it saw first — so the surviving row for the task's own PR
    // is not reliably labelled `task_output`.
    const matched = number === null ? undefined : pullRequests.find((pr) => pr.number === number);
    if (matched) return { url: matched.url, number: matched.number, state: matched.state };
    // Not in the link store: an older task, a URL outside the project repository the server
    // refuses to canonicalise, or a host whose URLs SAM does not parse. Still link to it.
    return { url: outputPrUrl, number, state: null };
  }
  const [first] = pullRequests;
  return first ? { url: first.url, number: first.number, state: first.state } : null;
}

function pickWorkingOn(ideas: readonly LinkedIdea[]): SessionWorkingOnIdea | null {
  const worksOn = ideas.find((idea) => idea.relations.includes('works_on'));
  if (worksOn) return { idea: worksOn, verb: 'Working on' };
  const discusses = ideas.find((idea) => idea.relations.includes('discusses'));
  return discusses ? { idea: discusses, verb: 'Discussing' } : null;
}

export function useSessionLinkedWork({
  projectId,
  sessionId,
  outputPrUrl,
}: {
  projectId: string;
  sessionId: string;
  /** `taskEmbed.outputPrUrl` — the PR the header already links to, when there is one. */
  outputPrUrl?: string | null;
}): SessionLinkedWork {
  const queryScope = useQueryScope();
  const enabled = Boolean(queryScope && projectId && sessionId);
  const query = useQuery({
    ...sessionLinksQueryOptions(queryScope, projectId, sessionId),
    enabled,
  });

  const { refetch } = query;
  // Narrowed to `() => void`: the drawer's Retry button must not hand React a promise.
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  return useMemo<SessionLinkedWork>(() => {
    const ideas = query.data?.ideas ?? emptyCappedList<LinkedIdea>();
    const files = query.data?.files ?? emptyCappedList<LinkedFile>();
    const pullRequests = query.data?.pullRequests ?? emptyCappedList<LinkedPullRequest>();
    return {
      ideas,
      files,
      pullRequests,
      workingOn: pickWorkingOn(ideas.items),
      primaryPullRequest: resolvePrimaryPullRequest(outputPrUrl, pullRequests.items),
      totalCount: ideas.total + files.total + pullRequests.total,
      totalIsLowerBound:
        ideas.totalIsLowerBound || files.totalIsLowerBound || pullRequests.totalIsLowerBound,
      isLoading: enabled && query.isPending,
      isError: query.isError && query.data === undefined,
      refetch: retry,
    };
  }, [query.data, query.isPending, query.isError, enabled, outputPrUrl, retry]);
}
