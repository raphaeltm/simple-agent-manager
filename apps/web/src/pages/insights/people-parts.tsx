/**
 * The People tab's sections. Flow, not people: each block says what is waiting on someone and
 * for how long, never how much anyone did. An item the viewer could not open in the Inbox shows
 * its kind and age only (the API never sends its title).
 */
import type {
  InsightsPeopleAskKind,
  InsightsReviewPickup,
  InsightsWaitingGroup,
  InsightsWaitingItem,
} from '@simple-agent-manager/shared';
import { Button, PersonAvatar, personSlotFor, Select } from '@simple-agent-manager/ui';
import { CircleHelp, GitPullRequest, ListChecks, Users } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';

import type { ProjectMemberSummary } from '../../hooks/useProjectMembers';
import { Empty } from './flow-parts';
import { formatDuration, formatDurationShort } from './format';

const KIND_LABEL: Record<InsightsPeopleAskKind, string> = {
  question: 'Question',
  review: 'Review',
  task: 'Task',
};

const KIND_ICON: Record<InsightsPeopleAskKind, typeof CircleHelp> = {
  question: CircleHelp,
  review: GitPullRequest,
  task: ListChecks,
};

function privateTitle(item: InsightsWaitingItem): string {
  return `${KIND_LABEL[item.kind]} for someone else`;
}

function groupTitle(group: InsightsWaitingGroup): string {
  if (group.kind === 'unassigned') return 'Not taken yet';
  if (group.you) return 'You';
  return group.name ?? 'A former member';
}

export type ReassignTarget = { assigneeUserId: string } | { team: true };

export interface ReassignControl {
  members: ProjectMemberSummary[];
  /** The ref currently being handed on, so only that row shows progress. */
  pendingRef: string | null;
  error: { ref: string; message: string } | null;
  onReassign: (ref: string, target: ReassignTarget) => void;
}

/** One person's open items, oldest first. */
export function WaitingGroup({
  group,
  projectId,
  reassign,
}: {
  group: InsightsWaitingGroup;
  projectId: string;
  reassign: ReassignControl;
}) {
  const title = groupTitle(group);
  const hidden = group.open - group.items.length;
  const summary = `${group.open} open · oldest ${formatDuration(group.oldestAgeMs)}${
    group.blocking > 0 ? ` · ${group.blocking} blocking` : ''
  }`;
  return (
    <section
      className="flex min-w-0 flex-col gap-1.5 border-0 border-t border-solid border-[var(--sam-hairline)] pt-3 first:border-t-0 first:pt-0"
      aria-label={`${title}: ${summary}`}
      data-testid={`insights-waiting-group-${group.key}`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {group.kind === 'unassigned' ? (
          <span className="inline-grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full sam-raised">
            <Users size={14} aria-hidden="true" className="text-fg-muted" />
          </span>
        ) : (
          <PersonAvatar
            name={group.you ? 'You' : group.name}
            person={personSlotFor(group.userId, group.you ? group.userId : null)}
            decorative
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="break-words text-[14px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
            {title}
          </span>
          <span className="text-[12.5px] text-fg-muted">{summary}</span>
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col p-0 sm:pl-[36px]">
        {group.items.map((item, index) => (
          <WaitingRow
            key={item.ref ?? `${group.key}-${item.createdAt}-${index}`}
            item={item}
            reassign={reassign}
          />
        ))}
      </ul>
      {(hidden > 0 || group.you) && (
        <p className="m-0 text-[12.5px] text-fg-muted sm:pl-[36px]">
          {hidden > 0 ? `${hidden} more, oldest shown first. ` : ''}
          {group.you && (
            <Link to={`/projects/${projectId}/inbox`} className="text-fg-primary">
              Open your inbox
            </Link>
          )}
        </p>
      )}
    </section>
  );
}

function WaitingRow({ item, reassign }: { item: InsightsWaitingItem; reassign: ReassignControl }) {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[item.kind];
  const ref = item.ref;
  const pending = ref !== null && reassign.pendingRef === ref;
  const error = ref !== null && reassign.error?.ref === ref ? reassign.error.message : null;
  const meta = [
    KIND_LABEL[item.kind],
    item.blocking ? 'agent is blocked' : null,
    item.claimed ? 'taken from the team' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex min-w-0 flex-col gap-2 py-2">
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-fg-muted" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={`line-clamp-2 break-words text-[13.5px] [overflow-wrap:anywhere] ${
              item.title === null ? 'italic text-fg-muted' : 'font-semibold text-fg-primary'
            }`}
          >
            {item.title ?? privateTitle(item)}
          </span>
          <span className="text-[12.5px] text-fg-muted">{meta}</span>
        </span>
        <span className="shrink-0 font-mono text-[12.5px] text-fg-muted">
          <span className="sr-only">Waiting for </span>
          {formatDurationShort(item.ageMs)}
        </span>
      </div>
      {item.canReassign && ref && (
        <div className="flex min-w-0 flex-col gap-1.5 pl-[26px]">
          {open ? (
            <ReassignForm
              itemRef={ref}
              title={item.title ?? privateTitle(item)}
              members={reassign.members}
              pending={pending}
              onCancel={() => setOpen(false)}
              onSubmit={(target) => reassign.onReassign(ref, target)}
            />
          ) : (
            <div>
              <Button
                variant="raised"
                size="sm"
                onClick={() => setOpen(true)}
                aria-label={`Reassign ${item.title ?? 'this task'}`}
              >
                Reassign
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="m-0 text-[12.5px] text-[var(--sam-color-danger)]">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

const TEAM = '__team__';

function ReassignForm({
  itemRef,
  title,
  members,
  pending,
  onCancel,
  onSubmit,
}: {
  itemRef: string;
  title: string;
  members: ProjectMemberSummary[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (target: ReassignTarget) => void;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  return (
    <form
      className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center"
      data-testid={`insights-reassign-form-${itemRef}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!value) return;
        onSubmit(value === TEAM ? { team: true } : { assigneeUserId: value });
      }}
    >
      <label htmlFor={id} className="sr-only">
        Give “{title}” to
      </label>
      <Select
        id={id}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="min-h-11 min-w-0 sm:max-w-[260px]"
      >
        <option value="">Choose who…</option>
        {members.map((member) => (
          <option key={member.userId} value={member.userId}>
            {member.name ?? member.email ?? 'Member'}
          </option>
        ))}
        <option value={TEAM}>Back to the team</option>
      </Select>
      <div className="flex gap-2">
        <Button type="submit" variant="accent" size="sm" disabled={!value} loading={pending}>
          Reassign
        </Button>
        <Button type="button" variant="raised" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function WaitingList({
  groups,
  projectId,
  reassign,
}: {
  groups: InsightsWaitingGroup[];
  projectId: string;
  reassign: ReassignControl;
}) {
  if (groups.length === 0) {
    return <Empty>Nothing is waiting on anyone: no open questions, reviews or tasks.</Empty>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="insights-waiting-list">
      {groups.map((group) => (
        <WaitingGroup key={group.key} group={group} projectId={projectId} reassign={reassign} />
      ))}
    </div>
  );
}

function since(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function ReviewPickupDetail({ pickup }: { pickup: InsightsReviewPickup }) {
  if (pickup.state === 'not_recorded') {
    return (
      <div className="flex min-w-0 flex-col gap-1.5" data-testid="insights-review-pickup">
        <Empty>
          {pickup.recordedSince
            ? `No review in this range was picked up yet. SAM records review requests since ${since(pickup.recordedSince)}.`
            : 'Not recorded yet. SAM records review requests from GitHub from now on; earlier ones are not known.'}
        </Empty>
        {pickup.waiting > 0 && (
          <p className="m-0 text-[12.5px] text-fg-muted">
            {pickup.waiting} {pickup.waiting === 1 ? 'request is' : 'requests are'} still waiting
            for a first review.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="insights-review-pickup">
      <dl className="m-0 grid grid-cols-2 gap-3">
        <div className="flex min-w-0 flex-col">
          <dt className="text-[12.5px] text-fg-muted">Median</dt>
          <dd className="m-0 text-[18px] font-semibold text-fg-primary">
            {formatDuration(pickup.medianMs)}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col">
          <dt className="text-[12.5px] text-fg-muted">9 in 10 within</dt>
          <dd className="m-0 text-[18px] font-semibold text-fg-primary">
            {formatDuration(pickup.p90Ms)}
          </dd>
        </div>
      </dl>
      <p className="m-0 text-[12.5px] text-fg-muted">
        From {pickup.samples} {pickup.samples === 1 ? 'review request' : 'review requests'} picked
        up in this range
        {pickup.waiting > 0 ? `, ${pickup.waiting} still waiting` : ''}. Recorded since{' '}
        {since(pickup.recordedSince)}
        {pickup.truncated ? '; only the most recent requests were examined' : ''}.
      </p>
    </div>
  );
}
