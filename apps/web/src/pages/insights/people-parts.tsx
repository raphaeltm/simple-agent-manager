/**
 * The People tab's sections. Flow, not people: each block says what is waiting on someone and
 * for how long, never how much anyone did. An item the viewer could not open in the Inbox shows
 * its age only (the API sends nothing else about it).
 */
import type {
  InsightsPeopleAskKind,
  InsightsReviewPickup,
  InsightsWaitingGroup,
  InsightsWaitingItem,
} from '@simple-agent-manager/shared';
import { Button, PersonAvatar, personSlotFor, Select } from '@simple-agent-manager/ui';
import { CircleHelp, GitPullRequest, ListChecks, Lock, Users } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';

import type { ProjectMemberSummary } from '../../hooks/useProjectMembers';
import { Empty } from './flow-parts';
import { formatDuration } from './format';

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

/** Small buttons stay 44px tall on a phone (SAM Glass touch targets). */
const TOUCH = 'max-sm:min-h-11';

function groupTitle(group: InsightsWaitingGroup): string {
  if (group.kind === 'unassigned') return 'Not taken yet';
  if (group.you) return 'You';
  return group.member ? (group.name ?? 'A member') : 'A former member';
}

export type ReassignTarget = { assigneeUserId: string } | { team: true };

export interface ReassignControl {
  members: ProjectMemberSummary[];
  /** True while the member list has not arrived: the form waits rather than offer only the team. */
  membersLoading: boolean;
  /** The ref being handed on, if any. While one is in flight every other submit waits. */
  pendingRef: string | null;
  error: { ref: string; message: string } | null;
  /** The last completed hand-on; `seq` grows by one per success. */
  done: { ref: string; seq: number } | null;
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
  const headingId = useId();
  const summary = `${group.open} open · oldest ${formatDuration(group.oldestAgeMs)}${
    group.blocking > 0 ? ` · ${group.blocking} blocking an agent` : ''
  }`;
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5 border-0 border-t border-solid border-[var(--sam-hairline)] pt-3 first:border-t-0 first:pt-0"
      data-testid={`insights-waiting-group-${group.key}`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {group.kind === 'unassigned' ? (
          <span className="sam-raised inline-grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full">
            <Users size={14} aria-hidden="true" className="text-fg-muted" />
          </span>
        ) : (
          <PersonAvatar
            name={group.you ? 'You' : group.member ? group.name : null}
            person={personSlotFor(group.userId, group.you ? group.userId : null)}
            decorative
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <h3
            id={headingId}
            className="m-0 break-words text-[14px] font-semibold text-fg-primary [overflow-wrap:anywhere]"
          >
            {title}
          </h3>
          <span className="text-[12.5px] text-fg-muted">{summary}</span>
        </div>
      </div>
      <ul className="m-0 flex list-none flex-col p-0 sm:pl-[36px]" aria-labelledby={headingId}>
        {group.items.map((item, index) => (
          <WaitingRow
            key={item.ref ?? `${group.key}-${item.createdAt}-${index}`}
            item={item}
            group={group}
            reassign={reassign}
          />
        ))}
      </ul>
      {(hidden > 0 || group.you) && (
        <p className="m-0 flex flex-wrap items-center gap-x-2 text-[12.5px] text-fg-muted sm:pl-[36px]">
          {hidden > 0 && <span>{hidden} more, the oldest are shown.</span>}
          {group.you && (
            <Link
              to={`/projects/${projectId}/inbox`}
              className="inline-flex min-h-11 items-center text-accent underline underline-offset-2 sm:min-h-0"
            >
              Open your inbox
            </Link>
          )}
        </p>
      )}
    </div>
  );
}

function WaitingRow({
  item,
  group,
  reassign,
}: {
  item: InsightsWaitingItem;
  group: InsightsWaitingGroup;
  reassign: ReassignControl;
}) {
  // The `done.seq` when the form was opened: a later success for this row closes it.
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const open =
    openedAt !== null &&
    !(reassign.done && reassign.done.ref === item.ref && reassign.done.seq > openedAt);
  const triggerRef = useRef<HTMLDivElement>(null);
  const Icon = item.kind ? KIND_ICON[item.kind] : Lock;
  const ref = item.ref;
  const pending = ref !== null && reassign.pendingRef === ref;
  const busy = reassign.pendingRef !== null;
  const error = ref !== null && reassign.error?.ref === ref ? reassign.error.message : null;
  const title = item.title ?? (item.kind ? KIND_LABEL[item.kind] : 'An item you cannot open');
  const meta = item.private
    ? null
    : [
        item.kind ? KIND_LABEL[item.kind] : null,
        item.blocking ? 'an agent is waiting on it' : null,
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
              item.private ? 'italic text-fg-muted' : 'font-semibold text-fg-primary'
            }`}
          >
            {title}
          </span>
          {meta && (
            <span
              className={`text-[12.5px] ${item.blocking ? 'font-semibold text-fg-primary' : 'text-fg-muted'}`}
            >
              {meta}
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[12.5px] text-fg-muted">
          <span className="sr-only">Waiting for </span>
          {formatDuration(item.ageMs)}
        </span>
      </div>
      {item.canReassign && ref && (
        <div className="flex min-w-0 flex-col gap-1.5 pl-[26px]">
          {open ? (
            <ReassignForm
              itemRef={ref}
              title={title}
              holder={group.kind === 'unassigned' ? 'team' : group.userId}
              control={reassign}
              pending={pending}
              busy={busy}
              onCancel={() => {
                setOpenedAt(null);
                // Focus returns to the control that opened the form.
                requestAnimationFrame(() => triggerRef.current?.querySelector('button')?.focus());
              }}
              onSubmit={(target) => reassign.onReassign(ref, target)}
            />
          ) : (
            <div ref={triggerRef}>
              <Button
                variant="ghost"
                size="sm"
                className={TOUCH}
                onClick={() => setOpenedAt(reassign.done?.seq ?? 0)}
                aria-label={`Reassign ${title}`}
              >
                Reassign
              </Button>
            </div>
          )}
          {error && (
            <p
              id={`${ref}-reassign-error`}
              role="alert"
              className="m-0 text-[12.5px] text-[var(--sam-color-danger)]"
            >
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
  holder,
  control,
  pending,
  busy,
  onCancel,
  onSubmit,
}: {
  itemRef: string;
  title: string;
  /** Who has it now (a user id, or `team`): not offered as a target. */
  holder: string | null;
  control: ReassignControl;
  pending: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (target: ReassignTarget) => void;
}) {
  const id = useId();
  const errorId = `${itemRef}-reassign-error`;
  const [value, setValue] = useState('');
  const options = control.members.filter((member) => member.userId !== holder);
  return (
    <form
      aria-label={`Reassign ${title}`}
      className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center"
      data-testid={`insights-reassign-form-${itemRef}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!value || busy) return;
        onSubmit(value === TEAM ? { team: true } : { assigneeUserId: value });
      }}
    >
      <label htmlFor={id} className="sr-only">
        Give “{title}” to
      </label>
      <Select
        id={id}
        value={value}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the person just asked for this form
        autoFocus
        disabled={pending}
        aria-describedby={errorId}
        onChange={(event) => setValue(event.target.value)}
        className="min-h-11 min-w-0 sm:max-w-[260px]"
      >
        <option value="">{control.membersLoading ? 'Loading people…' : 'Choose who…'}</option>
        {options.map((member) => (
          <option key={member.userId} value={member.userId}>
            {member.name ?? member.email ?? 'Member'}
          </option>
        ))}
        {holder !== 'team' && <option value={TEAM}>Back to the team</option>}
      </Select>
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="accent"
          size="sm"
          className={TOUCH}
          disabled={!value || busy}
          loading={pending}
        >
          Hand it on
        </Button>
        <Button
          type="button"
          variant="raised"
          size="sm"
          className={TOUCH}
          onClick={onCancel}
          disabled={pending}
        >
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
