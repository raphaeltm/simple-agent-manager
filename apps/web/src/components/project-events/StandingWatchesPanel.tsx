import {
  DEFAULT_PROJECT_EVENT_WATCH_COOLDOWN_MIN_MS,
  DEFAULT_PROJECT_EVENT_WATCH_MAX_CONCURRENT,
  DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS,
  PROJECT_EVENT_SEVERITIES,
  type ProjectEventFilterV1,
  type ProjectStandingWatch,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import {
  createStandingWatch,
  listStandingWatches,
  pauseStandingWatch,
  revokeStandingWatch,
  updateStandingWatch,
} from '../../lib/project-events-api';
import { EventActionFields, initialAction } from './EventActionFields';
import {
  ActionSummary,
  cardClass,
  controlClass,
  dateLabel,
  Feedback,
  Field,
  FilterSummary,
  QueryState,
  StateBadge,
  useEventAction,
} from './EventUi';

function WatchForm({
  projectId,
  existing,
  onClose,
  onSaved,
}: {
  projectId: string;
  existing?: ProjectStandingWatch;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [action, setAction] = useState(existing?.action ?? initialAction());
  const [filter, setFilter] = useState<ProjectEventFilterV1>(existing?.filter ?? { version: 1 });
  const [filterText, setFilterText] = useState(() =>
    Object.fromEntries(
      (['source', 'eventType', 'subjectType', 'subjectId'] as const).map((key) => {
        const value = existing?.filter[key];
        return [key, Array.isArray(value) ? value.join(', ') : (value ?? '')];
      })
    )
  );
  const [reason, setReason] = useState(existing?.reason ?? '');
  const [cooldown, setCooldown] = useState(
    (existing?.cooldownMs ?? DEFAULT_PROJECT_EVENT_WATCH_COOLDOWN_MIN_MS) / 60_000
  );
  const [concurrent, setConcurrent] = useState(existing?.maxConcurrent ?? 1);
  const [executions, setExecutions] = useState(
    existing?.maxExecutions ?? DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS
  );
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const operation = useEventAction();
  return (
    <form
      className={cardClass}
      onSubmit={(event) => {
        event.preventDefault();
        void operation.run(async () => {
          if (
            !Number.isFinite(cooldown) ||
            !Number.isSafeInteger(concurrent) ||
            !Number.isSafeInteger(executions)
          )
            throw new Error('Use finite limits and whole numbers for concurrency and executions.');
          const submittedFilter: ProjectEventFilterV1 = {
            version: 1,
            ...(filter.severity ? { severity: filter.severity } : {}),
          };
          for (const key of ['source', 'eventType', 'subjectType', 'subjectId'] as const) {
            const values = (filterText[key] ?? '')
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean);
            if (values.length) submittedFilter[key] = values.length === 1 ? values[0] : values;
          }
          if (!Object.keys(submittedFilter).some((key) => key !== 'version'))
            throw new Error('Set at least one event filter.');
          const body = {
            action,
            filter: submittedFilter,
            reason: reason.trim() || null,
            cooldownMs: Math.round(cooldown * 60_000),
            maxConcurrent: concurrent,
            maxExecutions: executions,
          };
          if (existing)
            await updateStandingWatch(projectId, existing.id, {
              ...body,
              expectedVersion: existing.version,
            });
          else await createStandingWatch(projectId, { ...body, idempotencyKey });
          onSaved();
        });
      }}
    >
      <h3 className="sam-type-section-heading m-0">
        {existing ? 'Edit watch' : 'Create standing watch'}
      </h3>
      <fieldset disabled={operation.busy} className="m-0 min-w-0 border-0 p-0 space-y-3">
        <p className="m-0 text-sm text-fg-muted">
          Fields combine with AND; comma-separated values within a field combine with OR. Blank
          fields match any value. Matches can start compute.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(['source', 'eventType', 'subjectType', 'subjectId'] as const).map((key) => (
            <Field
              key={key}
              label={
                {
                  source: 'Source',
                  eventType: 'Event type',
                  subjectType: 'Subject type',
                  subjectId: 'Subject ID',
                }[key]
              }
            >
              {(id) => (
                <input
                  id={id}
                  className={controlClass}
                  value={filterText[key] ?? ''}
                  onChange={(event) =>
                    setFilterText((previous) => ({ ...previous, [key]: event.target.value }))
                  }
                />
              )}
            </Field>
          ))}
        </div>
        <Field label="Severity">
          {(id) => (
            <select
              id={id}
              className={controlClass}
              value={Array.isArray(filter.severity) ? 'multiple' : (filter.severity ?? '')}
              onChange={(event) =>
                setFilter((previous) => {
                  const next = { ...previous };
                  if (event.target.value)
                    next.severity = event.target.value as (typeof PROJECT_EVENT_SEVERITIES)[number];
                  else delete next.severity;
                  return next;
                })
              }
            >
              <option value="">Any severity</option>
              {Array.isArray(filter.severity) && (
                <option value="multiple">{filter.severity.join(', ')}</option>
              )}
              {PROJECT_EVENT_SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          )}
        </Field>
        <EventActionFields projectId={projectId} value={action} onChange={setAction} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Cooldown (minutes)">
            {(id) => (
              <input
                id={id}
                required
                type="number"
                min={DEFAULT_PROJECT_EVENT_WATCH_COOLDOWN_MIN_MS / 60_000}
                step="1"
                className={controlClass}
                value={Number.isNaN(cooldown) ? '' : cooldown}
                onChange={(event) => setCooldown(event.target.valueAsNumber)}
              />
            )}
          </Field>
          <Field label="Concurrent executions" hint="Maximum work running at once.">
            {(id) => (
              <input
                id={id}
                required
                type="number"
                min="1"
                max={DEFAULT_PROJECT_EVENT_WATCH_MAX_CONCURRENT}
                step="1"
                className={controlClass}
                value={Number.isNaN(concurrent) ? '' : concurrent}
                onChange={(event) => setConcurrent(event.target.valueAsNumber)}
              />
            )}
          </Field>
          <Field
            label="Total execution limit"
            hint={
              existing
                ? `${existing.executionCount} executions already used.`
                : 'Finite lifetime limit; not a monetary budget.'
            }
          >
            {(id) => (
              <input
                id={id}
                required
                type="number"
                min={Math.max(1, existing?.executionCount ?? 0)}
                max={DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS}
                step="1"
                className={controlClass}
                value={Number.isNaN(executions) ? '' : executions}
                onChange={(event) => setExecutions(event.target.valueAsNumber)}
              />
            )}
          </Field>
        </div>
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
      </fieldset>
      <Feedback error={operation.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={operation.busy}>
          {existing ? 'Save watch' : 'Create watch'}
        </Button>
        <Button type="button" variant="secondary" disabled={operation.busy} onClick={onClose}>
          Close
        </Button>
      </div>
    </form>
  );
}

function WatchCard({
  watch,
  projectId,
  canWrite,
  creatorName,
  onEdit,
  onChanged,
}: {
  watch: ProjectStandingWatch;
  projectId: string;
  canWrite: boolean;
  creatorName: string;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const operation = useEventAction();
  const [confirm, setConfirm] = useState(false);
  return (
    <article className={cardClass}>
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="m-0 text-base font-semibold break-words">
          {watch.reason || `Watch ${watch.id.slice(0, 8)}`}
        </h3>
        <StateBadge state={watch.state} />
      </div>
      <p className="m-0 text-xs text-fg-muted break-words">
        Created by {creatorName} · {dateLabel(watch.createdAt)}
      </p>
      <FilterSummary filter={watch.filter} />
      <ActionSummary action={watch.action} projectId={projectId} />
      <p className="m-0 text-sm text-fg-muted">
        {watch.executionCount} / {watch.maxExecutions} executions · Up to {watch.maxConcurrent}{' '}
        concurrent · {watch.cooldownMs / 60_000} min cooldown
      </p>
      {watch.nextEligibleAt > Date.now() && (
        <p className="m-0 text-xs text-fg-muted">Next eligible {dateLabel(watch.nextEligibleAt)}</p>
      )}
      {watch.executionCount >= watch.maxExecutions && (
        <p className="m-0 text-sm text-fg-muted">
          Execution limit reached. This watch cannot admit more work at its current limit.
        </p>
      )}
      {watch.lastError && (
        <p className="m-0 text-sm text-danger break-words">Last error: {watch.lastError}</p>
      )}
      <Feedback error={operation.error} message={operation.message} />
      {canWrite && watch.state !== 'revoked' && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={operation.busy} onClick={onEdit}>
              Edit
            </Button>
            <Button
              variant="secondary"
              loading={operation.busy}
              onClick={() =>
                void operation.run(async () => {
                  await pauseStandingWatch(projectId, watch.id, {
                    expectedVersion: watch.version,
                    paused: watch.state !== 'paused',
                  });
                  onChanged();
                  return watch.state === 'paused'
                    ? 'Watch resumed.'
                    : 'Watch paused. Work already admitted may still run.';
                })
              }
            >
              {watch.state === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button variant="secondary" disabled={operation.busy} onClick={() => setConfirm(true)}>
              Revoke
            </Button>
          </div>
          {confirm && (
            <div className="space-y-2">
              <p className="m-0 text-sm">
                Permanently revoke this watch? Work already admitted may still run.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  loading={operation.busy}
                  onClick={() =>
                    void operation.run(async () => {
                      await revokeStandingWatch(projectId, watch.id, {
                        expectedVersion: watch.version,
                      });
                      setConfirm(false);
                      onChanged();
                      return 'Watch revoked.';
                    })
                  }
                >
                  Confirm revocation
                </Button>
                <Button
                  variant="secondary"
                  disabled={operation.busy}
                  onClick={() => setConfirm(false)}
                >
                  Keep watch
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function StandingWatchesPanel({
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
  const [form, setForm] = useState<'new' | ProjectStandingWatch | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['auth', scope, 'events', projectId, 'watches', sessionId, cursor],
    queryFn: () => listStandingWatches(projectId, cursor, sessionId),
    enabled: Boolean(scope),
  });
  return (
    <section className="space-y-4" aria-label="Standing watches">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0">Standing watches</h2>
          <p className="mt-1 mb-0 text-sm text-fg-muted">
            Run a bounded action when an event matches.
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
              Create watch
            </Button>
          )}
        </div>
      </div>
      <Feedback message={message} />
      {canWrite && form && (
        <WatchForm
          key={typeof form === 'string' ? 'new' : `${form.id}:${form.version}`}
          projectId={projectId}
          existing={typeof form === 'string' ? undefined : form}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            setMessage('Watch saved.');
            void query.refetch();
          }}
        />
      )}
      <QueryState
        pending={query.isPending}
        error={query.error}
        empty={!query.data?.watches.length}
        onRetry={() => void query.refetch()}
      >
        <div className="grid gap-4">
          {query.data?.watches.map((watch) => (
            <WatchCard
              key={`${watch.id}:${watch.version}`}
              watch={watch}
              projectId={projectId}
              canWrite={canWrite}
              creatorName={creatorName(watch.creatorUserId)}
              onEdit={() => setForm(watch)}
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
          <Button variant="secondary" onClick={() => setCursor(query.data!.nextCursor)}>
            Next page
          </Button>
        )}
      </div>
    </section>
  );
}
