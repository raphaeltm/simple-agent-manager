/**
 * One standing watch: what it waits for, what it does, its run limit, and the runs it started
 * (one-time actions carrying its `watchId`). Only its creator may change what it does; anyone
 * who can edit automation may change its filter, limits and name, pause it or stop it.
 */
import {
  DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS,
  type ProjectSchedule,
  type ProjectStandingWatch,
} from '@simple-agent-manager/shared';
import { Button, Dialog } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Pencil, Play } from 'lucide-react';
import { useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { AUTOMATION_RECENT_RUNS_PER_TRIGGER } from '../../lib/automation-config';
import { automationPaths } from '../../lib/automation-routes';
import {
  pauseStandingWatch,
  revokeStandingWatch,
  updateStandingWatch,
} from '../../lib/project-events-api';
import {
  automationQueryKeys,
  type BoundedList,
  schedulesQueryOptions,
  watchDetailQueryOptions,
} from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import { scheduleEntry } from './activity';
import { watchAdvancedRows } from './advanced-rows';
import { useAutomationAccess, useAutomationLookups } from './data';
import {
  ActionBar,
  AttentionCard,
  DangerSection,
  DetailLayout,
  DetailUnavailable,
  Fact,
  useAutomationAction,
  WhenAndThen,
} from './detail-parts';
import { Field, INPUT_CLASS } from './fields';
import { fromWatch } from './model';
import { Loading, Notice } from './page';
import { relative } from './time';
import {
  ButtonLink,
  Disclosure,
  KeyValues,
  OutcomeIcon,
  Panel,
  RowLink,
  SectionTitle,
  TextLink,
} from './ui';

function RaiseLimitDialog({
  watch,
  open,
  onClose,
}: {
  watch: ProjectStandingWatch;
  open: boolean;
  onClose: () => void;
}) {
  const { projectId } = useProjectContext();
  const max = DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS;
  const min = watch.executionCount + 1;
  const [value, setValue] = useState(String(Math.min(max, Math.max(min, watch.maxExecutions * 2))));
  const [error, setError] = useState<string | null>(null);
  // Only the limit: anyone with write access may change it, and leaving `action` out keeps a
  // non-creator's request inside what the API lets them do.
  const save = useAutomationAction(
    (maxExecutions: number) =>
      updateStandingWatch(projectId, watch.id, { expectedVersion: watch.version, maxExecutions }),
    { success: 'Run limit raised', failure: 'Could not raise the limit' },
    () => onClose()
  );
  return (
    <Dialog isOpen={open} onClose={onClose} aria-label="Give it more runs">
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          const next = Number(value);
          if (!Number.isInteger(next) || next < min || next > max) {
            setError(`Choose a whole number from ${min} to ${max}.`);
            return;
          }
          setError(null);
          save.mutate(next);
        }}
      >
        <h2 className="m-0 text-lg font-semibold text-fg-primary">Give it more runs</h2>
        <Field
          label="Total runs it may start"
          hint={`It has used ${watch.executionCount}. A watch can have at most ${max}.`}
          error={error}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="number"
              inputMode="numeric"
              min={min}
              max={max}
              className={INPUT_CLASS}
              value={value}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </Field>
        <div className="flex flex-wrap justify-end gap-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button type="submit" loading={save.isPending}>
            Save limit
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function WatchRuns({ watchId, runs }: { watchId: string; runs: ProjectSchedule[] }) {
  const { projectId } = useProjectContext();
  const shown = runs.slice(0, AUTOMATION_RECENT_RUNS_PER_TRIGGER);
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle
        title="Recent runs"
        count={runs.length || undefined}
        action={
          runs.length > shown.length ? (
            <TextLink to={automationPaths.history(projectId, { kind: 'watch', id: watchId })}>
              See all
            </TextLink>
          ) : undefined
        }
      />
      <Panel className="overflow-hidden" label="Runs">
        {shown.length === 0 ? (
          <p className="m-0 p-4 text-sm text-fg-muted">
            Nothing yet. Each time a matching event arrives, the run shows up here.
          </p>
        ) : (
          shown.map((run) => {
            const entry = scheduleEntry(run);
            return (
              <RowLink
                key={run.id}
                to={automationPaths.detail(projectId, 'schedule', run.id)}
                leading={<OutcomeIcon outcome={entry?.outcome ?? 'running'} />}
                title={
                  entry?.text ??
                  (run.state === 'cancelled' ? 'Cancelled before it ran' : 'Waiting to run')
                }
                meta={relative(run.updatedAt)}
              />
            );
          })
        )}
      </Panel>
    </div>
  );
}

export function WatchDetail({ watchId }: { watchId: string }) {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const access = useAutomationAccess();
  const lookups = useAutomationLookups(projectId);
  const [raising, setRaising] = useState(false);
  const [reason, setReason] = useState('');
  const query = useQuery({
    ...watchDetailQueryOptions(queryScope, projectId, watchId),
    enabled: Boolean(queryScope),
    placeholderData: () =>
      queryClient
        .getQueryData<BoundedList<ProjectStandingWatch>>(
          automationQueryKeys.watches(queryScope, projectId, null)
        )
        ?.items.find((candidate) => candidate.id === watchId),
  });
  const schedules = useQuery({
    ...schedulesQueryOptions(queryScope, projectId),
    enabled: Boolean(queryScope),
  });
  const watch = query.data;

  const setPaused = useAutomationAction(
    (current: { watch: ProjectStandingWatch; paused: boolean }) =>
      pauseStandingWatch(projectId, current.watch.id, {
        expectedVersion: current.watch.version,
        paused: current.paused,
      }),
    {
      success: (result) =>
        result.watch.state === 'paused'
          ? 'Paused. Runs it had queued were cancelled; work already going keeps running.'
          : 'Resumed. It reacts to new events again.',
      failure: 'Could not change it',
    }
  );
  const revoke = useAutomationAction(
    (current: ProjectStandingWatch) =>
      revokeStandingWatch(projectId, current.id, {
        expectedVersion: current.version,
        reason: reason.trim() || null,
      }),
    { success: 'Stopped for good', failure: 'Could not stop it' }
  );

  if (!watch) {
    if (query.isPending) return <Loading />;
    return <DetailUnavailable what="watch" error={query.error} />;
  }

  const runs = (schedules.data?.items ?? [])
    .filter((schedule) => schedule.watchId === watch.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  const item = fromWatch(watch, runs[0]?.createdAt ?? null);
  const revoked = watch.state === 'revoked';
  const exhausted = watch.executionCount >= watch.maxExecutions;
  const isCreator = watch.creatorUserId === access.userId;

  const actions =
    access.canWrite && !revoked ? (
      <ActionBar count={2}>
        {watch.state === 'paused' ? (
          <Button
            onClick={() => setPaused.mutate({ watch, paused: false })}
            loading={setPaused.isPending}
            disabled={exhausted}
            title={exhausted ? 'Give it more runs first' : undefined}
          >
            <Play size={16} aria-hidden /> Resume
          </Button>
        ) : (
          <Button
            variant="ghost"
            onClick={() => setPaused.mutate({ watch, paused: true })}
            loading={setPaused.isPending}
          >
            <Pause size={16} aria-hidden /> Pause
          </Button>
        )}
        <ButtonLink to={automationPaths.edit(projectId, 'watch', watch.id)}>
          <Pencil size={16} aria-hidden /> Edit
        </ButtonLink>
      </ActionBar>
    ) : !access.canWrite && !access.checking ? (
      <Notice>
        You can look, but only people who can edit this project can change automation.
      </Notice>
    ) : null;

  const limits = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Fact label="Runs used">
        {watch.executionCount} of {watch.maxExecutions}
      </Fact>
      <Fact label="Limits">
        {`Up to ${watch.maxConcurrent} at once · waits ${Math.round(watch.cooldownMs / 60_000)} min between runs`}
      </Fact>
    </div>
  );

  const main = (
    <>
      {item.attention && (
        <AttentionCard attention={item.attention}>
          {access.canWrite && item.attention.fix === 'raise-limit' && (
            <Button onClick={() => setRaising(true)}>Give it more runs</Button>
          )}
        </AttentionCard>
      )}
      {watch.state === 'active' && watch.lastError && (
        <Notice>The last run had a problem: {watch.lastError}</Notice>
      )}
      <WhenAndThen item={item} lookups={lookups} extra={limits} />
      {!isCreator && access.canWrite && !revoked && (
        <Notice>
          Only {access.personName(watch.creatorUserId)} can change what this watch does, because it
          acts as them. You can change what it waits for, its limits and its name.
        </Notice>
      )}
      <WatchRuns watchId={watch.id} runs={runs} />
    </>
  );

  const side = (
    <>
      <Disclosure title="Advanced" hint="Exact filter, limits and IDs" testId="automation-advanced">
        <KeyValues rows={watchAdvancedRows(watch, access.personName)} />
      </Disclosure>
      {access.canWrite && !revoked && (
        <DangerSection
          title="Stop for good"
          description="A stopped watch cannot be turned back on. Pause it instead if you may want it again."
          buttonLabel="Stop this watch"
          confirmTitle="Stop this watch for good?"
          confirmMessage={
            <div className="flex flex-col gap-3">
              <p className="m-0">
                It stops reacting to events and cannot be turned back on. Runs it queued that have
                not started are cancelled; work already going keeps running.
              </p>
              <Field label="Why (optional)">
                {({ id }) => (
                  <input
                    id={id}
                    type="text"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                )}
              </Field>
            </div>
          }
          confirmLabel="Stop it"
          busy={revoke.isPending}
          onConfirm={() => revoke.mutate(watch)}
        />
      )}
    </>
  );

  return (
    <>
      <DetailLayout item={item} actions={actions} main={main} side={side} />
      {raising && (
        <RaiseLimitDialog watch={watch} open={raising} onClose={() => setRaising(false)} />
      )}
    </>
  );
}
