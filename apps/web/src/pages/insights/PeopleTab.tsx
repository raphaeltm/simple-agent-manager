/**
 * Insights · People: where work waits on people, never how much anyone produced (Insights spec,
 * idea 01M7HTS38KX2G78JD0ESAGMKKH, slice P). One read (`projectPeople`), cached per project and
 * range; a range switch or a background refresh keeps the last numbers on screen
 * (`.claude/rules/48`).
 *
 * Reassign hands a human task on through the Inbox's own route (`reassignInboxTask`, inbox slice
 * H1). The server decides who may do it; the tab only offers it where the API says it may.
 */
import type { InsightsPeopleSection, ProjectPeopleResponse } from '@simple-agent-manager/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';

import { LoadError, Loading, Notice } from '../../components/page-kit/page';
import { useProjectMembers } from '../../hooks/useProjectMembers';
import { useQueryScope } from '../../hooks/useQueryScope';
import { reassignInboxTask } from '../../lib/api';
import {
  inboxQueryKeys,
  insightsQueryKeys,
  projectPeopleQueryOptions,
} from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import { Empty, FlowSection, Tile } from './flow-parts';
import { formatDuration, formatPercent } from './format';
import { useInsightsRange } from './index';
import {
  type ReassignControl,
  type ReassignTarget,
  ReviewPickupDetail,
  WaitingList,
} from './people-parts';

const SECTION_NAMES: Record<InsightsPeopleSection, string> = {
  waiting: 'what is waiting',
  reviews: 'review pickup',
  first_person: 'first-person answers',
};

export function PeopleTab() {
  const { projectId } = useProjectContext();
  const range = useInsightsRange();
  const queryScope = useQueryScope();
  const query = useQuery({
    ...projectPeopleQueryOptions(queryScope, projectId, range),
    enabled: Boolean(queryScope && projectId),
  });
  const data = query.data;

  if (!data) {
    if (query.isError) {
      return (
        <LoadError
          what="people insights"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      );
    }
    return <Loading label="Loading people…" />;
  }
  return <PeopleBody data={data} />;
}

export function PeopleBody({ data }: { data: ProjectPeopleResponse }) {
  const { waiting, reviewPickup, firstPerson } = data;
  const waitingFailed = data.unavailable.includes('waiting');
  const reviewsFailed = data.unavailable.includes('reviews');
  const firstFailed = data.unavailable.includes('first_person');
  const oldest = waiting.groups[0]?.oldestAgeMs ?? null;
  const canReassignAny = useMemo(
    () => waiting.groups.some((group) => group.items.some((item) => item.canReassign)),
    [waiting.groups]
  );

  return (
    <div
      className="flex min-w-0 flex-col gap-[var(--sam-space-gutter)]"
      data-testid="insights-people"
    >
      {data.unavailable.length > 0 && (
        <Notice>
          Some numbers could not be loaded:{' '}
          {data.unavailable.map((s) => SECTION_NAMES[s]).join(', ')}.
        </Notice>
      )}

      <div className="grid min-w-0 grid-cols-2 gap-[var(--sam-space-gutter)] lg:grid-cols-4">
        <Tile
          label="Waiting on people now"
          value={waitingFailed ? '—' : String(waiting.total)}
          detail={waitingFailed ? undefined : waiting.total === 1 ? 'open item' : 'open items'}
          testId="insights-tile-waiting"
        />
        <Tile
          label="Longest wait"
          value={waitingFailed ? '—' : formatDuration(oldest)}
          detail={oldest === null ? 'nothing waiting' : 'oldest open item'}
          testId="insights-tile-oldest"
        />
        <Tile
          label="Review pickup, median"
          value={
            reviewsFailed || reviewPickup.state !== 'recorded'
              ? '—'
              : formatDuration(reviewPickup.medianMs)
          }
          detail={
            reviewsFailed
              ? undefined
              : reviewPickup.state === 'recorded'
                ? `${reviewPickup.samples} ${reviewPickup.samples === 1 ? 'request' : 'requests'}`
                : 'not recorded yet'
          }
          testId="insights-tile-review-pickup"
        />
        <Tile
          label="Answered by the first person asked"
          value={firstFailed ? '—' : formatPercent(firstPerson.share)}
          detail={
            firstFailed
              ? undefined
              : firstPerson.closed === 0
                ? 'nothing answered yet'
                : `${firstPerson.firstPerson} of ${firstPerson.closed}`
          }
          testId="insights-tile-first-person"
        />
      </div>

      <div className="grid min-w-0 gap-[var(--sam-space-gutter)] lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <FlowSection
          title="Waiting on"
          note={waitingFailed ? undefined : 'Open questions, reviews and tasks, oldest first'}
          testId="insights-section-waiting"
        >
          {waitingFailed && waiting.groups.length === 0 ? (
            <Empty>What is waiting could not be loaded.</Empty>
          ) : (
            // Always the same component, so a hand-on that removes the last movable task keeps
            // its focus target and announcement mounted; only the member list is gated.
            <WaitingWithReassign data={data} needsMembers={canReassignAny} />
          )}
        </FlowSection>
        <div className="flex min-w-0 flex-col gap-[var(--sam-space-gutter)]">
          <FlowSection title="Review pickup" testId="insights-section-review-pickup">
            {reviewsFailed ? (
              <Empty>Review pickup could not be loaded.</Empty>
            ) : (
              <ReviewPickupDetail pickup={reviewPickup} />
            )}
          </FlowSection>
          <FlowSection
            title="Answered by the first person asked"
            testId="insights-section-first-person"
          >
            {firstFailed ? (
              <Empty>This could not be loaded.</Empty>
            ) : firstPerson.closed === 0 ? (
              <Empty>No question or task given to one person was answered in this range.</Empty>
            ) : (
              <p className="m-0 text-[13.5px] text-fg-muted">
                {firstPerson.firstPerson} of {firstPerson.closed} questions and tasks given to one
                person were answered by that person, without being handed on.
              </p>
            )}
          </FlowSection>
        </div>
      </div>

      <p className="m-0 px-1 text-[12.5px] text-fg-muted">
        This page shows where work waits, not how much anyone did. You see the items you can open in
        your inbox; for the rest, only how long they have waited.
      </p>
    </div>
  );
}

/**
 * The waiting list with reassign wired: loads the member list only when something can move. One
 * hand-on runs at a time; on success the People read and the Inbox are refreshed, the move is
 * announced, and focus goes to the list (the row the person acted on has moved away).
 */
function WaitingWithReassign({
  data,
  needsMembers,
}: {
  data: ProjectPeopleResponse;
  needsMembers: boolean;
}) {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const { members, isPending } = useProjectMembers(needsMembers ? data.projectId : null);
  const membersLoading = needsMembers && isPending;
  const [error, setError] = useState<{ ref: string; message: string } | null>(null);
  const [done, setDone] = useState<{ ref: string; seq: number } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const mutation = useMutation({
    mutationFn: ({ ref, target }: { ref: string; target: ReassignTarget }) =>
      reassignInboxTask(data.projectId, ref, target),
    onMutate: () => {
      setError(null);
      setAnnouncement('');
    },
    onSuccess: (_result, { ref, target }) => {
      // The row's form closes now, even if the refresh below fails.
      setDone((previous) => ({ ref, seq: (previous?.seq ?? 0) + 1 }));
      const who =
        'team' in target
          ? 'the team'
          : (members.find((member) => member.userId === target.assigneeUserId)?.name ??
            'the new person');
      setAnnouncement(`Handed on to ${who}.`);
      listRef.current?.focus();
      void queryClient.invalidateQueries({ queryKey: inboxQueryKeys.all(queryScope) });
      return queryClient.invalidateQueries({
        queryKey: insightsQueryKeys.peopleAll(queryScope, data.projectId),
      });
    },
    onError: (err, { ref }) =>
      setError({
        ref,
        message: err instanceof Error && err.message ? err.message : 'Could not reassign.',
      }),
  });
  const { mutate } = mutation;
  const onReassign = useCallback(
    (ref: string, target: ReassignTarget) => mutate({ ref, target }),
    [mutate]
  );
  const pendingRef = mutation.isPending ? (mutation.variables?.ref ?? null) : null;
  const control = useMemo<ReassignControl>(
    () => ({ members, membersLoading, pendingRef, error, done, onReassign }),
    [members, membersLoading, pendingRef, error, done, onReassign]
  );
  return (
    <div
      ref={listRef}
      tabIndex={-1}
      className="min-w-0 outline-none"
      data-testid="insights-waiting-region"
      aria-label="Waiting on"
    >
      <p
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="insights-reassign-status"
      >
        {announcement}
      </p>
      <WaitingList groups={data.waiting.groups} projectId={data.projectId} reassign={control} />
    </div>
  );
}
