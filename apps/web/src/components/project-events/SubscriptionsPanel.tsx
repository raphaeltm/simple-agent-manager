import type {
  ProjectEventSubscriptionRecord,
  ProjectEventSubscriptionState,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';

import { useQueryScope } from '../../hooks/useQueryScope';
import { cancelEventSubscription, listEventSubscriptions } from '../../lib/project-events-api';
import {
  cardClass,
  controlClass,
  dateLabel,
  Feedback,
  Field,
  FilterSummary,
  linkClass,
  QueryState,
  StateBadge,
  useEventAction,
} from './EventUi';

function SubscriptionCard({
  subscription,
  projectId,
  canWrite,
  onChanged,
}: {
  subscription: ProjectEventSubscriptionRecord;
  projectId: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const operation = useEventAction();
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState('');
  const target = subscription.deliveryPreference.target;
  const managed = subscription.owner.type !== 'human' && subscription.owner.type !== 'agent';
  return (
    <article className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="m-0 min-w-0 text-base font-semibold break-words">
          {subscription.reason || `Subscription ${subscription.id.slice(0, 8)}`}
        </h3>
        <StateBadge state={subscription.state} />
      </div>
      <p className="m-0 text-xs text-fg-muted break-words">
        Owner: {subscription.owner.name || subscription.owner.id} (
        {subscription.owner.type.replaceAll('_', ' ')}) · Created{' '}
        {dateLabel(subscription.createdAt)}
      </p>
      <FilterSummary filter={subscription.filter} />
      <dl className="m-0 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-fg-muted">Requested delivery</dt>
          <dd className="m-0 break-words">
            {subscription.deliveryPreference.requested.replaceAll('_', ' ')}
          </dd>
        </div>
        <div>
          <dt className="text-fg-muted">Resolved delivery</dt>
          <dd className="m-0 break-words">
            {subscription.deliveryPreference.resolved.replaceAll('_', ' ')}
          </dd>
        </div>
      </dl>
      <p className="m-0 text-xs text-fg-muted">
        Resolved delivery describes routing capability, not confirmation that an agent read the
        event.
      </p>
      {target?.sessionId && (
        <Link className={linkClass} to={`/projects/${projectId}/chat/${target.sessionId}`}>
          Open target session
        </Link>
      )}
      {target?.taskId && (
        <p className="m-0 text-xs text-fg-muted break-all">Target task: {target.taskId}</p>
      )}
      <p className="m-0 text-xs text-fg-muted">
        Expires: {dateLabel(subscription.expiresAt)} · Last match:{' '}
        {dateLabel(subscription.lastMatchedAt)}
      </p>
      {subscription.cancelReason && (
        <p className="m-0 text-sm break-words">Cancellation reason: {subscription.cancelReason}</p>
      )}
      {managed && (
        <p className="m-0 text-sm text-fg-muted">
          Managed by its {subscription.owner.type.replaceAll('_', ' ')}.{' '}
          {subscription.owner.type === 'standing_watch' && (
            <Link className={linkClass} to={`/projects/${projectId}/events?section=watches`}>
              Manage standing watches
            </Link>
          )}
        </p>
      )}
      <Feedback error={operation.error} message={operation.message} />
      {canWrite &&
        !managed &&
        subscription.state === 'active' &&
        (confirm ? (
          <div className="space-y-2">
            <p className="m-0 text-sm">
              Cancel future matches? Work already admitted may still run.
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
                    await cancelEventSubscription(
                      projectId,
                      subscription.id,
                      reason.trim() || undefined
                    );
                    setConfirm(false);
                    onChanged();
                    return 'Subscription cancelled.';
                  })
                }
              >
                Confirm cancellation
              </Button>
              <Button
                variant="secondary"
                disabled={operation.busy}
                onClick={() => setConfirm(false)}
              >
                Keep subscription
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setConfirm(true)}>
            Cancel subscription
          </Button>
        ))}
    </article>
  );
}

export function SubscriptionsPanel({
  projectId,
  sessionId,
  canWrite,
}: {
  projectId: string;
  sessionId?: string;
  canWrite: boolean;
}) {
  const scope = useQueryScope();
  const [state, setState] = useState<ProjectEventSubscriptionState | 'any'>('any');
  const query = useQuery({
    queryKey: ['auth', scope, 'events', projectId, 'subscriptions', sessionId, state],
    queryFn: () => listEventSubscriptions(projectId, sessionId, state),
    enabled: Boolean(scope),
  });
  const subscriptions = query.data?.subscriptions ?? [];
  return (
    <section className="space-y-4" aria-label="Subscriptions">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0">Subscriptions</h2>
          <p className="mt-1 mb-0 text-sm text-fg-muted">
            Inspect what agents and policies follow, and how events are routed.
          </p>
        </div>
        <Button variant="secondary" loading={query.isFetching} onClick={() => void query.refetch()}>
          Refresh
        </Button>
      </div>
      <div className="max-w-xs">
        <Field label="Subscription state">
          {(id) => (
            <select
              id={id}
              className={controlClass}
              value={state}
              onChange={(event) =>
                setState(event.target.value as ProjectEventSubscriptionState | 'any')
              }
            >
              <option value="any">All states</option>
              <option value="active">Active</option>
              <option value="cancelled">Cancelled</option>
              <option value="expired">Expired</option>
            </select>
          )}
        </Field>
      </div>
      <QueryState
        pending={query.isPending}
        error={query.error}
        empty={!subscriptions.length}
        onRetry={() => void query.refetch()}
      >
        <div className="grid gap-4">
          {subscriptions.map((subscription) => (
            <SubscriptionCard
              key={subscription.id}
              subscription={subscription}
              projectId={projectId}
              canWrite={canWrite}
              onChanged={() => void query.refetch()}
            />
          ))}
        </div>
      </QueryState>
      {query.data?.hasMore && (
        <p role="status" className="text-sm text-fg-muted">
          Showing a bounded set of subscriptions. Open Events from a session to narrow the results.
          The subscription API does not provide a next-page cursor.
        </p>
      )}
    </section>
  );
}
