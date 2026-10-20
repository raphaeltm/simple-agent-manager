/**
 * What agents are waiting for: event subscriptions, in plain words. SAM's own agent-to-agent
 * relays are hidden unless asked for and can never be stopped here; subscriptions owned by a
 * watch or the platform are managed by their owner.
 */
import type { ProjectEventSubscriptionRecord } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { Hourglass } from 'lucide-react';
import { useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useQueryScope } from '../../hooks/useQueryScope';
import { automationPaths } from '../../lib/automation-routes';
import { cancelEventSubscription } from '../../lib/project-events-api';
import { subscriptionDeliveriesQueryOptions } from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import type { AutomationLookups } from './data';
import { describeEventFilter, filterRows, isManagedSubscription, isSamRelay } from './describe';
import { useAutomationAction } from './detail-parts';
import { CheckRow, Field } from './fields';
import { fullDate, relative } from './time';
import { ButtonLink, Disclosure, KeyValues, LoadError, Loading, Panel } from './ui';

const DELIVERY_WORDS: Record<string, string> = {
  pending: 'Waiting to be delivered',
  delivered: 'Delivered to the chat',
  acked: 'Read by the agent',
  recorded_not_injected: 'Recorded for the agent to read',
  failed: 'Could not be delivered',
  ambiguous: 'Delivery not confirmed',
  expired: 'Expired before delivery',
  cancelled: 'Cancelled',
};

function DeliveryOutcomes({ subscriptionId }: { subscriptionId: string }) {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const query = useQuery({
    ...subscriptionDeliveriesQueryOptions(queryScope, projectId, subscriptionId),
    enabled: Boolean(queryScope),
  });
  if (query.isPending) return <Loading label="Loading deliveries…" />;
  if (query.isError)
    return <LoadError what="deliveries" error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data.deliveries.length)
    return <p className="m-0 text-[13px] text-fg-muted">Nothing has matched yet.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {query.data.deliveries.map((delivery) => (
        <li key={delivery.id} className="flex flex-col gap-0.5 text-[13px]">
          <span className="font-semibold text-fg-primary">
            {DELIVERY_WORDS[delivery.state] ?? delivery.state.replaceAll('_', ' ')}
          </span>
          <span className="text-fg-muted">
            {fullDate(delivery.createdAt)}
            {delivery.ackedAt ? ` · read ${relative(delivery.ackedAt)}` : ''}
            {delivery.terminalReason ? ` · ${delivery.terminalReason}` : ''}
          </span>
        </li>
      ))}
      {query.data.hasMore && (
        <li className="text-[13px] text-fg-muted">Older deliveries are not shown.</li>
      )}
    </ul>
  );
}

export function WaitCard({
  subscription,
  lookups,
  canWrite,
}: {
  subscription: ProjectEventSubscriptionRecord;
  lookups: AutomationLookups;
  canWrite: boolean;
}) {
  const { projectId } = useProjectContext();
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState('');
  // Delivery history is one request per subscription: load it only when someone asks.
  const [detailsOpened, setDetailsOpened] = useState(false);
  const stop = useAutomationAction(
    () => cancelEventSubscription(projectId, subscription.id, reason.trim() || undefined),
    { success: 'Stopped waiting', failure: 'Could not stop it' }
  );
  const target = subscription.deliveryPreference.target?.sessionId;
  const managed = isManagedSubscription(subscription);
  // Agent owner names are raw session ids, so a chat title (or a plain role) reads better.
  const who = target
    ? lookups.chatTitle(target)
    : subscription.owner.type === 'standing_watch'
      ? 'A watch'
      : subscription.owner.type === 'human'
        ? 'Someone'
        : managed
          ? 'SAM'
          : 'An agent';
  const what = describeEventFilter(subscription.filter).noun;
  const relay = isSamRelay(subscription);
  const active = subscription.state === 'active';
  return (
    <Panel className="flex flex-col gap-3 p-4" label={`${who} waits for ${what}`}>
      <div className="flex gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-fg-muted">
          <Hourglass size={18} aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="m-0 text-[15px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
            {who} {active ? 'is waiting for' : 'was waiting for'} {what}
          </p>
          <span className="text-[13px] text-fg-muted">
            {active
              ? `Since ${relative(subscription.createdAt)}${subscription.expiresAt ? ` · gives up ${relative(subscription.expiresAt)}` : ''}`
              : `${subscription.state === 'expired' ? 'Expired' : 'Stopped'} ${relative(subscription.cancelledAt ?? subscription.updatedAt)}${subscription.cancelReason ? `: ${subscription.cancelReason}` : ''}`}
            {subscription.lastMatchedAt
              ? ` · last matched ${relative(subscription.lastMatchedAt)}`
              : ''}
          </span>
          {relay && (
            <span className="text-[13px] text-fg-muted">
              SAM manages this relay for messages between agents.
            </span>
          )}
          {managed && (
            <span className="text-[13px] text-fg-muted">
              Managed by its {subscription.owner.type.replaceAll('_', ' ')}, so it cannot be stopped
              here.
            </span>
          )}
        </div>
      </div>
      <Disclosure
        title="Details"
        hint="Exact filter, delivery and IDs"
        onToggle={(open) => open && setDetailsOpened(true)}
      >
        <KeyValues
          mono
          rows={[
            ...filterRows(subscription.filter),
            ['Asked for', subscription.deliveryPreference.requested.replaceAll('_', ' ')],
            ['Delivered as', subscription.deliveryPreference.resolved.replaceAll('_', ' ')],
            [
              'Owner',
              `${subscription.owner.name || subscription.owner.id} (${subscription.owner.type.replaceAll('_', ' ')})`,
            ],
            ...(subscription.reason
              ? ([['Reason', subscription.reason]] as Array<[string, string]>)
              : []),
            ['ID', subscription.id],
          ]}
        />
        <span className="text-[13px] font-semibold text-fg-primary">Recent deliveries</span>
        {detailsOpened && <DeliveryOutcomes subscriptionId={subscription.id} />}
      </Disclosure>
      <div className="flex flex-wrap gap-3">
        {target && (
          <ButtonLink
            to={`/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(target)}`}
          >
            Open the chat
          </ButtonLink>
        )}
        {managed && subscription.owner.type === 'standing_watch' && (
          <ButtonLink to={automationPaths.detail(projectId, 'watch', subscription.owner.id)}>
            Open the watch
          </ButtonLink>
        )}
        {canWrite && active && !relay && !managed && (
          <Button variant="ghost" onClick={() => setConfirm(true)} loading={stop.isPending}>
            Stop waiting
          </Button>
        )}
      </div>
      <ConfirmDialog
        isOpen={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          stop.mutate();
        }}
        title="Stop waiting?"
        message={
          <div className="flex flex-col gap-3">
            <p className="m-0">
              The agent will not hear about {what} any more. Anything already delivered stays.
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
        confirmLabel="Stop waiting"
        loading={stop.isPending}
      />
    </Panel>
  );
}

/** A list of waits with SAM's relays behind a switch. */
export function WaitList({
  subscriptions,
  lookups,
  canWrite,
  emptyText,
}: {
  subscriptions: ProjectEventSubscriptionRecord[];
  lookups: AutomationLookups;
  canWrite: boolean;
  emptyText: string;
}) {
  const [showRelays, setShowRelays] = useState(false);
  const relays = subscriptions.filter(isSamRelay);
  const visible = showRelays
    ? subscriptions
    : subscriptions.filter((subscription) => !isSamRelay(subscription));
  return (
    <div className="flex flex-col gap-3">
      {visible.length === 0 ? (
        <p className="m-0 rounded-xl border border-dashed border-border-default p-4 text-sm text-fg-muted">
          {emptyText}
        </p>
      ) : (
        visible.map((subscription) => (
          <WaitCard
            key={subscription.id}
            subscription={subscription}
            lookups={lookups}
            canWrite={canWrite}
          />
        ))
      )}
      {relays.length > 0 && (
        <CheckRow
          checked={showRelays}
          onChange={setShowRelays}
          label={`Show SAM’s own message relays (${relays.length})`}
          hint="SAM sets these up so agents can message each other. They clean themselves up."
        />
      )}
    </div>
  );
}
