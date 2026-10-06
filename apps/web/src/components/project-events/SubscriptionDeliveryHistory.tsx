import { Button } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { listEventSubscriptionDeliveries } from '../../lib/project-events-api';
import { dateLabel, QueryState, StateBadge } from './EventUi';

/** Mounted only after a member explicitly asks to inspect this subscription. */
export function SubscriptionDeliveryHistory({
  projectId,
  subscriptionId,
  id,
}: {
  projectId: string;
  subscriptionId: string;
  id: string;
}) {
  const scope = useQueryScope();
  const heading = useRef<HTMLHeadingElement>(null);
  const query = useQuery({
    queryKey: ['auth', scope, 'events', projectId, 'subscription-deliveries', subscriptionId],
    queryFn: () => listEventSubscriptionDeliveries(projectId, subscriptionId),
    enabled: Boolean(scope),
    retry: false,
  });
  // Opening the panel moves focus to its heading; refreshing keeps the user's focus.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <section
      id={id}
      aria-label="Recent delivery outcomes"
      className="min-w-0 space-y-3 border-t border-border-default pt-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 ref={heading} tabIndex={-1} className="m-0 text-sm font-semibold">
          Recent delivery outcomes
        </h4>
        <Button
          variant="secondary"
          size="sm"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh outcomes
        </Button>
      </div>
      <p className="m-0 text-xs text-fg-muted">
        Delivery confirms transport receipt, not that the agent read or acted on it. An
        acknowledgment is shown separately.
      </p>
      <QueryState
        pending={query.isPending}
        error={query.error}
        empty={false}
        onRetry={() => void query.refetch()}
      >
        {!query.data?.deliveries.length ? (
          <p className="m-0 text-sm text-fg-muted">No delivery outcomes recorded yet.</p>
        ) : (
          <ol className="m-0 list-none space-y-3 p-0">
            {query.data.deliveries.map((delivery) => (
              <li
                key={delivery.id}
                className="min-w-0 rounded-md border border-border-default p-3 space-y-2"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="text-sm font-medium">{dateLabel(delivery.createdAt)}</span>
                  <StateBadge state={delivery.state} />
                </div>
                <dl className="m-0 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-fg-muted">Delivery method</dt>
                    <dd className="m-0">
                      {delivery.deliveredVia === 'pull'
                        ? 'Event tools'
                        : delivery.deliveredVia === 'prompt_queue'
                          ? 'Session prompt'
                          : 'No delivery recorded'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-fg-muted">Last updated</dt>
                    <dd className="m-0">{dateLabel(delivery.updatedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-fg-muted">Delivered</dt>
                    <dd className="m-0">
                      {delivery.deliveredAt === null
                        ? 'Not recorded'
                        : dateLabel(delivery.deliveredAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-fg-muted">Acknowledged</dt>
                    <dd className="m-0">
                      {delivery.ackedAt === null ? 'Not recorded' : dateLabel(delivery.ackedAt)}
                    </dd>
                  </div>
                </dl>
                {delivery.terminalReason && (
                  <p className="m-0 text-sm break-words">Reason: {delivery.terminalReason}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </QueryState>
      {!query.error && query.data?.hasMore && (
        <p className="m-0 text-xs text-fg-muted">
          Showing recent deliveries. Older outcomes are not included in this view.
        </p>
      )}
    </section>
  );
}
