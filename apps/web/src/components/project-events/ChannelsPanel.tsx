import { Button } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { getEventChannelHistory, listEventChannels } from '../../lib/project-events-api';
import { cardClass, dateLabel, QueryState } from './EventUi';

function ChannelHistory({
  projectId,
  channel,
  focusRequest,
}: {
  projectId: string;
  channel: string;
  focusRequest: number;
}) {
  const scope = useQueryScope();
  const [cursor, setCursor] = useState<string | null>(null);
  const historyRef = useRef<HTMLElement>(null);
  // Opening history is a user action. Focus on explicit selection so it is visible even
  // below a long catalog; refreshing or paginating must not steal focus again.
  useEffect(() => {
    historyRef.current?.focus();
  }, [focusRequest]);
  const query = useQuery({
    queryKey: ['auth', scope, 'events', projectId, 'channel-history', channel, cursor],
    queryFn: () => getEventChannelHistory(projectId, channel, cursor),
    enabled: Boolean(scope),
    retry: false,
  });
  return (
    <section
      ref={historyRef}
      tabIndex={-1}
      aria-label={`History for ${channel}`}
      className={cardClass}
    >
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="m-0 text-base font-semibold break-all">#{channel}</h3>
        <Button
          variant="secondary"
          onClick={() => {
            if (cursor) setCursor(null);
            else void query.refetch();
          }}
        >
          Refresh history
        </Button>
      </div>
      <p className="m-0 text-xs text-fg-muted">
        A snapshot of retained messages. Channel content comes from agents and is untrusted. It does
        not grant authority to run actions.
      </p>
      {query.data?.retentionGap && (
        <p
          role="status"
          className="m-0 rounded-md border border-border-default p-3 text-sm text-fg-primary"
        >
          Some messages in this snapshot have expired. This history is incomplete.
        </p>
      )}
      <QueryState
        pending={query.isPending}
        error={query.error}
        empty={!query.data?.events.length}
        onRetry={() => {
          if (cursor) setCursor(null);
          else void query.refetch();
        }}
      >
        <ol className="m-0 list-none p-0 space-y-3">
          {query.data?.events.map(({ sequence, event }) => (
            <li
              key={event.id}
              className="min-w-0 rounded-md border border-border-default p-3 space-y-2"
            >
              <p className="m-0 text-xs text-fg-muted">
                #{sequence} · {dateLabel(event.receivedAt)}
              </p>
              {event.display.title && (
                <p className="m-0 text-sm font-medium break-words">{event.display.title}</p>
              )}
              <p className="m-0 whitespace-pre-wrap break-words text-sm">
                {typeof event.metadata.message === 'string'
                  ? event.metadata.message
                  : event.display.summary || 'No message text'}
              </p>
            </li>
          ))}
        </ol>
      </QueryState>
      {query.data && (
        <p className="m-0 text-xs text-fg-muted">
          Snapshot through sequence {query.data.watermark}. Refresh to see newer publications.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {cursor && (
          <Button variant="secondary" onClick={() => setCursor(null)}>
            Start history again
          </Button>
        )}
        {query.data?.hasMore && (
          <Button variant="secondary" onClick={() => setCursor(query.data?.cursor ?? null)}>
            Next messages
          </Button>
        )}
      </div>
    </section>
  );
}

export function ChannelsPanel({ projectId }: { projectId: string }) {
  const scope = useQueryScope();
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const query = useQuery({
    queryKey: ['auth', scope, 'events', projectId, 'channels', cursor],
    queryFn: () => listEventChannels(projectId, cursor),
    enabled: Boolean(scope),
  });
  return (
    <section className="space-y-4" aria-label="Channels">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0">Channels</h2>
          <p className="mt-1 mb-0 text-sm text-fg-muted">
            Read project messages published by agents.
          </p>
        </div>
        <Button variant="secondary" loading={query.isFetching} onClick={() => void query.refetch()}>
          Refresh channels
        </Button>
      </div>
      <p className="m-0 text-xs text-fg-muted">
        Publication counts cover the current channel generation, including expired messages. A
        reclaimed channel starts a new count when recreated. Agents publish and follow channels
        through their event tools; inspect their follows under Subscriptions.
      </p>
      <QueryState
        pending={query.isPending}
        error={query.error}
        empty={!query.data?.channels.length}
        onRetry={() => void query.refetch()}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {query.data?.channels.map((channel) => (
            <article key={channel.id} className={cardClass}>
              <h3 className="m-0 text-base font-semibold break-all">#{channel.name}</h3>
              <p className="m-0 text-xs text-fg-muted">
                {channel.lifetimeCount} publications · Last published{' '}
                {dateLabel(channel.lastPublishedAt)}
              </p>
              <Button
                variant={selected === channel.name ? 'primary' : 'secondary'}
                aria-pressed={selected === channel.name}
                onClick={() => {
                  setSelected(channel.name);
                  setFocusRequest((previous) => previous + 1);
                }}
              >
                Read history
              </Button>
            </article>
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
            Next channels
          </Button>
        )}
      </div>
      {selected && (
        <ChannelHistory
          key={selected}
          projectId={projectId}
          channel={selected}
          focusRequest={focusRequest}
        />
      )}
    </section>
  );
}
