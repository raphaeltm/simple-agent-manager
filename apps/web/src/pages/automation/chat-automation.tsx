/**
 * Automation that concerns one chat: what it is waiting for, and the one-time messages and
 * watches aimed at it. Shown in the chat's tool-rail panel and, full width, at
 * `automation/behind?sessionId=` (where the old chat-scoped Events links land).
 */
import { useQuery } from '@tanstack/react-query';
import { AlarmClock } from 'lucide-react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { AUTOMATION_ATTENTION_WINDOW_MS } from '../../lib/automation-config';
import { automationPaths } from '../../lib/automation-routes';
import {
  schedulesQueryOptions,
  subscriptionsQueryOptions,
  watchesQueryOptions,
} from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import { useAutomationAccess, useAutomationLookups } from './data';
import { fromSchedule, fromWatch, isFinished } from './model';
import { AutomationRow } from './overview-sections';
import { ButtonLink, LoadError, Loading, Panel, SectionTitle } from './ui';
import { WaitList } from './waiting';

export function ChatAutomation({ sessionId }: { sessionId: string }) {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const access = useAutomationAccess();
  const lookups = useAutomationLookups(projectId);
  const enabled = Boolean(queryScope);
  const waits = useQuery({
    ...subscriptionsQueryOptions(queryScope, projectId, sessionId, 'active'),
    enabled,
  });
  const schedules = useQuery({
    ...schedulesQueryOptions(queryScope, projectId, sessionId),
    enabled,
  });
  const watches = useQuery({ ...watchesQueryOptions(queryScope, projectId, sessionId), enabled });

  const now = Date.now();
  // The sessionId filter also matches schedules this chat created; keep the ones still to come.
  const upcoming = (schedules.data?.items ?? [])
    .filter((schedule) => !schedule.watchId)
    .map((schedule) => fromSchedule(schedule, now, AUTOMATION_ATTENTION_WINDOW_MS))
    .filter((item) => !isFinished(item) || item.attention)
    .sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
  const reacting = (watches.data?.items ?? [])
    .filter((watch) => watch.state !== 'revoked')
    .map((watch) => fromWatch(watch, null));

  return (
    <div className="flex flex-col gap-6" data-testid="chat-automation">
      {access.canWrite && (
        <ButtonLink
          to={automationPaths.create(projectId, { sessionId })}
          variant="primary"
          className="w-full sm:w-fit"
        >
          <AlarmClock size={18} aria-hidden /> Remind this chat later
        </ButtonLink>
      )}
      <div className="flex flex-col gap-2">
        <SectionTitle title="Waiting for" hint="Things an agent here asked to hear about" />
        {waits.isPending ? (
          <Loading />
        ) : waits.isError ? (
          <LoadError
            what="what this chat waits for"
            error={waits.error}
            onRetry={() => void waits.refetch()}
          />
        ) : (
          <WaitList
            subscriptions={waits.data.subscriptions}
            lookups={lookups}
            canWrite={access.canWrite}
            emptyText="This chat is not waiting for anything."
          />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <SectionTitle title="Coming up for this chat" />
        {schedules.isPending || watches.isPending ? (
          <Loading />
        ) : schedules.isError || watches.isError ? (
          <LoadError
            what="automation for this chat"
            error={schedules.error ?? watches.error}
            onRetry={() => void Promise.all([schedules.refetch(), watches.refetch()])}
          />
        ) : upcoming.length + reacting.length === 0 ? (
          <p className="m-0 rounded-xl border border-dashed border-border-default p-4 text-sm text-fg-muted">
            Nothing is set to message this chat.
          </p>
        ) : (
          <Panel className="overflow-hidden" label="Coming up for this chat">
            {[...upcoming, ...reacting].map((item) => (
              <AutomationRow key={`${item.kind}:${item.id}`} item={item} lookups={lookups} />
            ))}
          </Panel>
        )}
      </div>
    </div>
  );
}
