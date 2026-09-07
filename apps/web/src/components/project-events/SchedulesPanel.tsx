import {
  DEFAULT_PROJECT_EVENT_SCHEDULE_LATE_GRACE_MS,
  type ProjectSchedule,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';

import { useQueryScope } from '../../hooks/useQueryScope';
import {
  cancelSchedule,
  createSchedule,
  listSchedules,
  rescheduleSchedule,
} from '../../lib/project-events-api';
import { EventActionFields, initialAction } from './EventActionFields';
import {
  ActionSummary,
  cardClass,
  controlClass,
  dateLabel,
  Feedback,
  Field,
  linkClass,
  localDateInput,
  QueryState,
  StateBadge,
  timezone,
  useEventAction,
} from './EventUi';
import { ScheduleExecution } from './ScheduleExecution';

function ScheduleForm({
  projectId,
  sessionId,
  existing,
  onSaved,
  onClose,
}: {
  projectId: string;
  sessionId?: string;
  existing?: ProjectSchedule;
  onSaved: (message: string) => void;
  onClose: () => void;
}) {
  const [action, setAction] = useState(existing?.action ?? initialAction(sessionId));
  const [due, setDue] = useState(existing ? localDateInput(existing.dueAt) : '');
  const [expires, setExpires] = useState(existing ? localDateInput(existing.expiresAt) : '');
  const [reason, setReason] = useState(existing?.reason ?? '');
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const operation = useEventAction();
  return (
    <form
      className={cardClass}
      onSubmit={(event) => {
        event.preventDefault();
        void operation.run(async () => {
          const dueAt = new Date(due).getTime();
          const expiresAt = new Date(expires).getTime();
          if (
            !Number.isFinite(dueAt) ||
            !Number.isFinite(expiresAt) ||
            dueAt <= Date.now() ||
            expiresAt <= dueAt
          ) {
            throw new Error('Choose a future due time and an expiry after that time.');
          }
          const result = existing
            ? await rescheduleSchedule(projectId, existing.id, {
                expectedVersion: existing.version,
                dueAt,
                expiresAt,
                displayTimezone: timezone,
              })
            : await createSchedule(projectId, {
                action,
                dueAt,
                expiresAt,
                displayTimezone: timezone,
                reason: reason.trim() || null,
                idempotencyKey,
              });
          onSaved(
            result.actionAlreadyAdmitted
              ? 'This action was already admitted. Its work may still run; the schedule change cannot undo it.'
              : existing
                ? 'Schedule updated.'
                : 'Schedule created.'
          );
        });
      }}
    >
      <h3 className="sam-type-section-heading m-0">
        {existing ? 'Reschedule action' : 'Schedule once'}
      </h3>
      <fieldset disabled={operation.busy} className="m-0 min-w-0 border-0 p-0 space-y-3">
        {!existing && (
          <EventActionFields projectId={projectId} value={action} onChange={setAction} />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Run at" hint={`Local time in ${timezone}`}>
            {(id) => (
              <input
                id={id}
                type="datetime-local"
                required
                className={controlClass}
                value={due}
                onChange={(event) => {
                  setDue(event.target.value);
                  if (!expires && event.target.value)
                    setExpires(
                      localDateInput(
                        new Date(event.target.value).getTime() +
                          DEFAULT_PROJECT_EVENT_SCHEDULE_LATE_GRACE_MS
                      )
                    );
                }}
              />
            )}
          </Field>
          <Field label="Expires at" hint="Do not start this action after this time.">
            {(id) => (
              <input
                id={id}
                type="datetime-local"
                required
                className={controlClass}
                value={expires}
                min={due}
                onChange={(event) => setExpires(event.target.value)}
              />
            )}
          </Field>
        </div>
        {!existing && (
          <Field label="Reason (optional)">
            {(id) => (
              <input
                id={id}
                className={controlClass}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
        )}
        <p className="m-0 text-xs text-fg-muted">
          Delivery may be late while infrastructure or the target session is busy. New sessions
          consume compute. Expiry bounds how long admission may be retried.
        </p>
      </fieldset>
      <Feedback error={operation.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={operation.busy}>
          {existing ? 'Save new time' : 'Create schedule'}
        </Button>
        <Button type="button" variant="secondary" disabled={operation.busy} onClick={onClose}>
          Close
        </Button>
      </div>
    </form>
  );
}

function ScheduleCard({
  schedule,
  projectId,
  canWrite,
  creatorName,
  onEdit,
  onChanged,
}: {
  schedule: ProjectSchedule;
  projectId: string;
  canWrite: boolean;
  creatorName: string;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const operation = useEventAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reason, setReason] = useState('');
  const mutable = schedule.state === 'pending' || schedule.state === 'processing';
  return (
    <article className={cardClass}>
      <div className="flex flex-wrap justify-between items-start gap-2">
        <h3 className="m-0 text-base font-semibold break-words">
          {dateLabel(schedule.dueAt, schedule.displayTimezone)}
        </h3>
        <span className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          Schedule state <StateBadge state={schedule.state} />
        </span>
      </div>
      <p className="m-0 text-xs text-fg-muted break-words">
        {schedule.displayTimezone} · Created by {creatorName} · {dateLabel(schedule.createdAt)}
      </p>
      <ActionSummary action={schedule.action} projectId={projectId} />
      {schedule.watchId && (
        <p className="m-0 text-xs text-fg-muted break-words">
          Standing watch {schedule.watchId}
          {schedule.sourceEventId ? ` · Event ${schedule.sourceEventId}` : ''}
        </p>
      )}
      {schedule.reason && <p className="m-0 text-sm break-words">Reason: {schedule.reason}</p>}
      <p className="m-0 text-xs text-fg-muted">
        Expires {dateLabel(schedule.expiresAt)} · Attempts {schedule.attemptCount}
        {schedule.nextAttemptAt ? ` · Next attempt ${dateLabel(schedule.nextAttemptAt)}` : ''}
      </p>
      {mutable && schedule.dueAt < Date.now() && (
        <p className="m-0 text-sm text-fg-muted">
          Past its due time. Delivery may be waiting for capacity or a busy session; it can retry
          until expiry.
        </p>
      )}
      {schedule.state === 'ambiguous' && (
        <p className="m-0 text-sm text-fg-muted">
          The action may have started, but confirmation is unavailable. Check the target before
          creating another schedule.
        </p>
      )}
      {schedule.state === 'admitted' && (
        <p className="m-0 text-sm text-fg-muted">
          The action was accepted for delivery. This does not mean its work has finished.
        </p>
      )}
      {schedule.lastError && (
        <p className="m-0 text-sm text-danger break-words">Last error: {schedule.lastError}</p>
      )}
      {schedule.resultSessionId && (
        <Link className={linkClass} to={`/projects/${projectId}/chat/${schedule.resultSessionId}`}>
          Open resulting session
        </Link>
      )}
      <Feedback error={operation.error} message={operation.message} />
      <ScheduleExecution
        schedule={schedule}
        projectId={projectId}
        canWrite={canWrite}
        onChanged={onChanged}
      />
      {canWrite && mutable && (
        <div className="space-y-3">
          {confirmCancel ? (
            <div className="space-y-2">
              <p className="m-0 text-sm">
                Cancel this scheduled action? Work already admitted may still run.
              </p>
              <Field label="Cancellation reason (optional)">
                {(id) => (
                  <input
                    id={id}
                    className={controlClass}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                )}
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  loading={operation.busy}
                  onClick={() =>
                    void operation.run(async () => {
                      const result = await cancelSchedule(projectId, schedule.id, {
                        expectedVersion: schedule.version,
                        reason: reason.trim() || null,
                      });
                      setConfirmCancel(false);
                      onChanged();
                      return result.actionAlreadyAdmitted
                        ? 'Already admitted: work may still run.'
                        : 'Schedule cancelled.';
                    })
                  }
                >
                  Confirm cancellation
                </Button>
                <Button
                  variant="secondary"
                  disabled={operation.busy}
                  onClick={() => setConfirmCancel(false)}
                >
                  Keep schedule
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={onEdit}>
                Reschedule
              </Button>
              <Button variant="secondary" onClick={() => setConfirmCancel(true)}>
                Cancel schedule
              </Button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function SchedulesPanel({
  projectId,
  sessionId,
  canWrite,
  creatorName,
}: {
  projectId: string;
  sessionId?: string;
  canWrite: boolean;
  creatorName: (id: string) => string;
}) {
  const scope = useQueryScope();
  const [cursor, setCursor] = useState<string | null>(null);
  const [form, setForm] = useState<'new' | ProjectSchedule | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['auth', scope, 'events', projectId, 'schedules', sessionId, cursor],
    queryFn: () => listSchedules(projectId, cursor, sessionId),
    enabled: Boolean(scope),
  });
  return (
    <section className="space-y-4" aria-label="Schedules">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0">Schedules</h2>
          <p className="mt-1 mb-0 text-sm text-fg-muted">
            One action, at a finite time, with a delivery deadline.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh
          </Button>
          {canWrite && (
            <Button
              onClick={() => {
                setForm('new');
                setMessage(null);
              }}
            >
              Schedule once
            </Button>
          )}
        </div>
      </div>
      <Feedback message={message} />
      {canWrite && form && (
        <ScheduleForm
          key={typeof form === 'string' ? 'new' : `${form.id}:${form.version}`}
          projectId={projectId}
          sessionId={sessionId}
          existing={typeof form === 'string' ? undefined : form}
          onClose={() => setForm(null)}
          onSaved={(text) => {
            setForm(null);
            setMessage(text);
            void query.refetch();
          }}
        />
      )}
      <QueryState
        pending={query.isPending}
        error={query.error}
        empty={!query.data?.schedules.length}
        onRetry={() => void query.refetch()}
      >
        <div className="grid gap-4">
          {query.data?.schedules.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              schedule={schedule}
              projectId={projectId}
              canWrite={canWrite}
              creatorName={creatorName(schedule.creatorUserId)}
              onEdit={() => setForm(schedule)}
              onChanged={() => void query.refetch()}
            />
          ))}
        </div>
      </QueryState>
      <div className="flex flex-wrap gap-2">
        {cursor && (
          <Button variant="secondary" onClick={() => setCursor(null)}>
            First page
          </Button>
        )}
        {query.data?.nextCursor && (
          <Button variant="secondary" onClick={() => setCursor(query.data?.nextCursor ?? null)}>
            Next page
          </Button>
        )}
      </div>
    </section>
  );
}
