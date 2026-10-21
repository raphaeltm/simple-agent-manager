/**
 * One one-time automation: change its time, run it now, cancel it, and after it ran, check the
 * result (receipt) or retry a task submission that may not have gone through.
 */
import type { ProjectSchedule } from '@simple-agent-manager/shared';
import { Button, Dialog } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Play, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useQueryScope } from '../../hooks/useQueryScope';
import { AUTOMATION_ATTENTION_WINDOW_MS } from '../../lib/automation-config';
import { automationPaths } from '../../lib/automation-routes';
import {
  cancelSchedule,
  reconcileSchedule,
  rescheduleSchedule,
} from '../../lib/project-events-api';
import {
  automationQueryKeys,
  type BoundedList,
  scheduleDetailQueryOptions,
} from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import { scheduleAdvancedRows } from './advanced-rows';
import { useAutomationAccess, useAutomationLookups } from './data';
import {
  ActionBar,
  AttentionCard,
  DetailLayout,
  DetailUnavailable,
  Fact,
  useAutomationAction,
  WhenAndThen,
} from './detail-parts';
import { Field } from './fields';
import { fromSchedule } from './model';
import { Loading, Notice } from './page';
import { type OnceTime, OnceTimeFields, onceTimeFrom, resolveOnceTime } from './schedule-time';
import { fullDate } from './time';
import { Disclosure, KeyValues, Panel, SectionTitle, TextLink } from './ui';

const chatPath = (projectId: string, sessionId: string) =>
  `/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(sessionId)}`;

function ChangeTimeDialog({
  schedule,
  open,
  onClose,
}: {
  schedule: ProjectSchedule;
  open: boolean;
  onClose: () => void;
}) {
  const { projectId } = useProjectContext();
  const [time, setTime] = useState<OnceTime>(() =>
    onceTimeFrom(
      Math.max(schedule.dueAt, Date.now() + 5 * 60_000),
      schedule.displayTimezone,
      schedule.expiresAt
    )
  );
  const [error, setError] = useState<string | null>(null);
  const save = useAutomationAction(
    (next: { dueAt: number; expiresAt: number }) =>
      rescheduleSchedule(projectId, schedule.id, {
        expectedVersion: schedule.version,
        dueAt: next.dueAt,
        expiresAt: next.expiresAt,
        displayTimezone: time.zone,
      }),
    {
      success: (result) =>
        result.actionAlreadyAdmitted
          ? 'It had already started, so the new time cannot apply.'
          : 'New time saved',
      failure: 'Could not change the time',
    },
    () => onClose()
  );
  return (
    <Dialog isOpen={open} onClose={onClose} aria-label="Change when it runs">
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          const resolved = resolveOnceTime(time);
          if ('error' in resolved) {
            setError(resolved.error);
            return;
          }
          setError(null);
          save.mutate(resolved);
        }}
      >
        <h2 className="m-0 text-lg font-semibold text-fg-primary">Change when it runs</h2>
        <OnceTimeFields value={time} onChange={setTime} error={error} />
        <div className="flex flex-wrap justify-end gap-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Keep the current time
          </Button>
          <Button type="submit" loading={save.isPending}>
            Save new time
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** What happened when it ran, and the recovery tools the API offers when that is unclear. */
function ScheduleResult({ schedule, canWrite }: { schedule: ProjectSchedule; canWrite: boolean }) {
  const { projectId } = useProjectContext();
  const [confirmRetry, setConfirmRetry] = useState(false);
  const execution = schedule.execution;
  const recover = useAutomationAction(
    (retrySubmission: boolean) =>
      reconcileSchedule(projectId, schedule.id, {
        expectedVersion: schedule.version,
        ...(retrySubmission ? { retrySubmission: true } : {}),
      }),
    {
      success: (result) => result.recovery?.message ?? 'Checked. The result below is up to date.',
      failure: 'Could not check the result',
    }
  );
  const sessionId = schedule.resultSessionId ?? execution?.sessionId ?? null;
  const canRetry =
    schedule.action.kind === 'start_session' && execution?.retrySubmissionAllowed === true;
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle
        title="What happened"
        hint={
          schedule.action.kind === 'message_session'
            ? 'Whether the chat received the message.'
            : 'Whether the chat it should start was created.'
        }
      />
      <Panel className="flex flex-col gap-4 p-4 md:p-5" label="Result">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Fact label="Status">{execution?.status.replaceAll('_', ' ') ?? 'Not checked yet'}</Fact>
          {execution && <Fact label="Checked">{fullDate(execution.checkedAt)}</Fact>}
        </div>
        {execution?.error && (
          <p className="m-0 text-sm text-danger-fg [overflow-wrap:anywhere]">{execution.error}</p>
        )}
        {schedule.state === 'ambiguous' && (
          <p className="m-0 text-sm text-fg-muted">
            It may have started, but SAM could not confirm it. Check the result before scheduling it
            again, so it does not run twice.
          </p>
        )}
        {sessionId && <TextLink to={chatPath(projectId, sessionId)}>Open the chat</TextLink>}
        {canWrite && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-3">
              <Button
                variant="ghost"
                loading={recover.isPending && !confirmRetry}
                onClick={() => recover.mutate(false)}
              >
                Check the result again
              </Button>
              {canRetry && (
                <Button
                  variant="ghost"
                  onClick={() => setConfirmRetry(true)}
                  disabled={recover.isPending}
                >
                  Try submitting again
                </Button>
              )}
            </div>
            <p className="m-0 text-[13px] text-fg-muted">
              Checking reads what SAM recorded. It does not wake a chat or send anything again.
            </p>
          </div>
        )}
      </Panel>
      <ConfirmDialog
        isOpen={confirmRetry}
        onClose={() => setConfirmRetry(false)}
        onConfirm={() => {
          setConfirmRetry(false);
          recover.mutate(true);
        }}
        title="Try submitting the task again?"
        message={`This may start a chat and use compute. It keeps the same task, so it cannot create a duplicate${
          execution?.submissionDeadline
            ? `, and it is possible until ${fullDate(execution.submissionDeadline)}`
            : ''
        }.`}
        confirmLabel="Submit again"
        variant="warning"
        loading={recover.isPending}
      />
    </div>
  );
}

export function ScheduleDetail({ scheduleId }: { scheduleId: string }) {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const access = useAutomationAccess();
  const lookups = useAutomationLookups(projectId);
  const [changing, setChanging] = useState(false);
  const [confirmRunNow, setConfirmRunNow] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reason, setReason] = useState('');
  const query = useQuery({
    ...scheduleDetailQueryOptions(queryScope, projectId, scheduleId),
    enabled: Boolean(queryScope),
    placeholderData: () =>
      queryClient
        .getQueryData<BoundedList<ProjectSchedule>>(
          automationQueryKeys.schedules(queryScope, projectId, null)
        )
        ?.items.find((candidate) => candidate.id === scheduleId),
  });
  const schedule = query.data;

  const runNow = useAutomationAction(
    (current: ProjectSchedule) => {
      const now = Date.now();
      return rescheduleSchedule(projectId, current.id, {
        expectedVersion: current.version,
        dueAt: now,
        expiresAt: now + Math.max(current.expiresAt - current.dueAt, 15 * 60_000),
        displayTimezone: current.displayTimezone,
      });
    },
    {
      success: (result) =>
        result.actionAlreadyAdmitted ? 'It had already started.' : 'It will start within a minute.',
      failure: 'Could not run it now',
    }
  );
  const cancel = useAutomationAction(
    (current: ProjectSchedule) =>
      cancelSchedule(projectId, current.id, {
        expectedVersion: current.version,
        reason: reason.trim() || null,
      }),
    {
      success: (result) =>
        result.actionAlreadyAdmitted
          ? 'It had already started. Cancelling cannot undo work that began.'
          : 'Cancelled. It will not run.',
      failure: 'Could not cancel it',
    }
  );

  if (!schedule) {
    if (query.isPending) return <Loading />;
    return <DetailUnavailable what="automation" error={query.error} />;
  }
  const item = fromSchedule(schedule, Date.now(), AUTOMATION_ATTENTION_WINDOW_MS);
  const waiting = schedule.state === 'pending' || schedule.state === 'processing';

  const actions =
    access.canWrite && waiting ? (
      <ActionBar count={schedule.state === 'pending' ? 3 : 1}>
        {schedule.state === 'pending' && (
          <>
            <Button
              variant="ghost"
              onClick={() => setConfirmRunNow(true)}
              loading={runNow.isPending}
            >
              <Play size={16} aria-hidden /> Run now
            </Button>
            <Button variant="ghost" onClick={() => setChanging(true)}>
              <Clock size={16} aria-hidden /> Change time
            </Button>
          </>
        )}
        <Button variant="ghost" onClick={() => setConfirmCancel(true)} loading={cancel.isPending}>
          <X size={16} aria-hidden /> Cancel
        </Button>
      </ActionBar>
    ) : !access.canWrite && !access.checking ? (
      <Notice>
        You can look, but only people who can edit this project can change automation.
      </Notice>
    ) : null;

  const main = (
    <>
      {item.attention && <AttentionCard attention={item.attention} />}
      {schedule.watchId && (
        <Notice tone="info">
          A watch started this when a matching event arrived.{' '}
          <Link
            className="font-semibold text-info-fg"
            to={automationPaths.detail(projectId, 'watch', schedule.watchId)}
          >
            Open the watch
          </Link>
        </Notice>
      )}
      <WhenAndThen item={item} lookups={lookups} />
      {!waiting && <ScheduleResult schedule={schedule} canWrite={access.canWrite} />}
      {waiting && schedule.lastError && (
        <Notice>
          The last try did not work: {schedule.lastError}. It keeps trying until{' '}
          {fullDate(schedule.expiresAt)}.
        </Notice>
      )}
    </>
  );
  const side = (
    <Disclosure title="Advanced" hint="Exact times, attempts and IDs" testId="automation-advanced">
      <KeyValues rows={scheduleAdvancedRows(schedule, access.personName)} />
    </Disclosure>
  );

  return (
    <>
      <DetailLayout item={item} actions={actions} main={main} side={side} />
      {changing && (
        <ChangeTimeDialog schedule={schedule} open={changing} onClose={() => setChanging(false)} />
      )}
      <ConfirmDialog
        isOpen={confirmRunNow}
        onClose={() => setConfirmRunNow(false)}
        onConfirm={() => {
          setConfirmRunNow(false);
          runNow.mutate(schedule);
        }}
        title="Run it now?"
        message={`It starts within a minute instead of ${fullDate(schedule.dueAt)}.`}
        confirmLabel="Run now"
        variant="info"
        loading={runNow.isPending}
      />
      <ConfirmDialog
        isOpen={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          cancel.mutate(schedule);
        }}
        title="Cancel this automation?"
        message={
          <div className="flex flex-col gap-3">
            <p className="m-0">
              It will not run. If it has already started, that work keeps going.
            </p>
            <Field label="Why (optional)" hint="Shown on this page for whoever looks next.">
              {({ id, describedBy }) => (
                <input
                  id={id}
                  type="text"
                  value={reason}
                  aria-describedby={describedBy}
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
            </Field>
          </div>
        }
        confirmLabel="Cancel it"
        cancelLabel="Keep it"
        loading={cancel.isPending}
      />
    </>
  );
}
