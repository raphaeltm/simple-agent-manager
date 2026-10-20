/**
 * One trigger: a recurring schedule, a GitHub or webhook reaction, or (admins only) the private
 * incident backlog. Every action the old trigger pages offered lives here: run now, pause and
 * resume, turn on, edit, delete, run clean-up, and the webhook connection.
 */
import type { TriggerResponse } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Pencil, Play, Power } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';

import { TriggerCredentialWarning } from '../../components/triggers/TriggerCredentialWarning';
import { useQueryScope } from '../../hooks/useQueryScope';
import { deleteTrigger, runTrigger, updateTrigger } from '../../lib/api';
import { automationPaths } from '../../lib/automation-routes';
import { triggerDetailQueryOptions, triggerQueryKeys } from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import { triggerAdvancedRows } from './advanced-rows';
import { useAutomationAccess, useAutomationLookups } from './data';
import {
  ActionBar,
  AttentionCard,
  DangerSection,
  DetailLayout,
  DetailUnavailable,
  useAutomationAction,
  WhenAndThen,
} from './detail-parts';
import { fromTrigger } from './model';
import { TriggerRuns, useTriggerRuns } from './trigger-runs';
import { ConnectWebhook, TryWebhook, WebhookDeliveries } from './trigger-webhook';
import { ButtonLink, Disclosure, KeyValues, Loading, Notice } from './ui';

export function TriggerDetail({
  triggerId,
  scrollToRuns = false,
}: {
  triggerId: string;
  scrollToRuns?: boolean;
}) {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const access = useAutomationAccess();
  const lookups = useAutomationLookups(projectId);
  const query = useQuery({
    ...triggerDetailQueryOptions(queryScope, projectId, triggerId),
    enabled: Boolean(queryScope),
    // The list the user came from already has this trigger: show it while the detail loads.
    placeholderData: () =>
      queryClient
        .getQueryData<TriggerResponse[]>(triggerQueryKeys.list(queryScope, projectId))
        ?.find((candidate) => candidate.id === triggerId),
  });
  const runs = useTriggerRuns(triggerId);
  // "See the runs" from the overview lands here with #runs; scroll once they have rendered.
  const runsReady = Boolean(runs.data);
  useEffect(() => {
    if (scrollToRuns && runsReady)
      document.getElementById('runs')?.scrollIntoView({ block: 'start' });
  }, [runsReady, scrollToRuns]);

  const setStatus = useAutomationAction(
    (status: TriggerResponse['status']) => updateTrigger(projectId, triggerId, { status }),
    {
      success: (updated) =>
        updated.status === 'paused'
          ? 'Paused. Nothing starts until you resume it.'
          : 'On. It runs again from now.',
      failure: 'Could not change it',
    }
  );
  const runNow = useAutomationAction(() => runTrigger(projectId, triggerId), {
    success: 'Started a run. It shows up under Recent runs.',
    failure: 'Could not start a run',
  });
  const remove = useAutomationAction(
    () => deleteTrigger(projectId, triggerId),
    { success: 'Deleted', failure: 'Could not delete it' },
    () => navigate(automationPaths.overview(projectId), { replace: true })
  );

  const trigger = query.data;
  if (!trigger) {
    if (query.isPending) return <Loading />;
    return <DetailUnavailable what="automation" error={query.error} />;
  }

  const firstRuns = runs.data?.pages[0]?.executions;
  const item = fromTrigger(trigger, firstRuns);
  const incident = trigger.sourceType === 'incident';
  const canRun = access.canWrite && !incident && trigger.status !== 'disabled';
  const busy = setStatus.isPending || runNow.isPending;

  const toggle =
    trigger.status === 'paused' ? (
      <Button onClick={() => setStatus.mutate('active')} loading={setStatus.isPending}>
        <Play size={16} aria-hidden /> Resume
      </Button>
    ) : trigger.status === 'disabled' ? (
      <Button onClick={() => setStatus.mutate('active')} loading={setStatus.isPending}>
        <Power size={16} aria-hidden /> Turn on
      </Button>
    ) : (
      <Button
        variant="ghost"
        onClick={() => setStatus.mutate('paused')}
        loading={setStatus.isPending}
      >
        <Pause size={16} aria-hidden /> Pause
      </Button>
    );
  const runButton = canRun ? (
    <Button
      variant="ghost"
      onClick={() => runNow.mutate()}
      loading={runNow.isPending}
      disabled={busy}
    >
      <Play size={16} aria-hidden /> Run now
    </Button>
  ) : null;
  const edit = (
    <ButtonLink to={automationPaths.edit(projectId, 'trigger', triggerId)}>
      <Pencil size={16} aria-hidden /> Edit
    </ButtonLink>
  );

  const actions = access.canWrite ? (
    <ActionBar count={runButton ? 3 : 2}>
      {trigger.status === 'active' ? (
        <>
          {runButton}
          {toggle}
        </>
      ) : (
        <>
          {toggle}
          {runButton}
        </>
      )}
      {edit}
    </ActionBar>
  ) : access.checking ? null : (
    <Notice>You can look, but only people who can edit this project can change automation.</Notice>
  );

  const main = (
    <>
      {item.attention && (
        // Resume is already in the action bar above; the card only adds the way to the runs.
        <AttentionCard attention={item.attention}>
          {item.attention.fix === 'review-runs' && (
            <Button
              variant="ghost"
              onClick={() =>
                document.getElementById('runs')?.scrollIntoView({ behavior: 'smooth' })
              }
            >
              See the runs
            </Button>
          )}
        </AttentionCard>
      )}
      {trigger.credentialAttribution?.hasPersonalWarning && (
        <TriggerCredentialWarning trigger={trigger} />
      )}
      {incident && (
        <Notice tone="info">
          Only the scheduled incident sweep starts this automation, so it cannot be run by hand. You
          can still change its prompt, pause it or delete it.
        </Notice>
      )}
      <WhenAndThen item={item} lookups={lookups} />
      <TriggerRuns trigger={trigger} canWrite={access.canWrite} runs={runs} />
      {trigger.sourceType === 'webhook' && (
        <>
          <TryWebhook trigger={trigger} />
          <WebhookDeliveries trigger={trigger} />
        </>
      )}
    </>
  );

  const side = (
    <>
      {trigger.sourceType === 'webhook' && (
        <ConnectWebhook trigger={trigger} canWrite={access.canWrite} />
      )}
      <Disclosure
        title="Advanced"
        hint="Exact schedule, filters, limits and IDs"
        testId="automation-advanced"
      >
        <KeyValues rows={triggerAdvancedRows(trigger, lookups, access.personName)} />
      </Disclosure>
      {access.canWrite && (
        <DangerSection
          title="Delete"
          description="Deleting removes this automation and its run history. Chats it started stay."
          buttonLabel="Delete automation"
          confirmTitle="Delete this automation?"
          confirmMessage={`This permanently deletes “${trigger.name}” and all its run history. Chats it started stay.`}
          confirmLabel="Delete"
          busy={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      )}
    </>
  );

  return <DetailLayout item={item} actions={actions} main={main} side={side} />;
}
