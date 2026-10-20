/**
 * Agent channels: named feeds agents publish to and follow. Sorted by last activity; SAM's
 * private agent-to-agent threads (`agent-dm.*`) are hidden unless asked for. Posts are written
 * by agents, so their text is shown as untrusted content, never as instructions.
 */
import type { ProjectEventChannel } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Hash } from 'lucide-react';
import { useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { channelHistoryQueryOptions, channelsQueryOptions } from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import type { AutomationLookups } from './data';
import { CheckRow } from './fields';
import { fullDate, relative } from './time';
import { LoadError, Loading, Notice, Panel } from './ui';

function ChannelHistory({ channel, lookups }: { channel: string; lookups: AutomationLookups }) {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const history = useInfiniteQuery({
    ...channelHistoryQueryOptions(queryScope, projectId, channel),
    enabled: Boolean(queryScope),
  });
  if (history.isPending) return <Loading label="Loading posts…" />;
  if (history.isError)
    return (
      <LoadError what="this channel" error={history.error} onRetry={() => void history.refetch()} />
    );
  const pages = history.data.pages;
  const posts = pages.flatMap((page) => page.events);
  return (
    <div className="flex flex-col gap-3 border-0 border-t border-solid border-border-default px-4 py-4">
      {pages.some((page) => page.retentionGap) && (
        <Notice>Some older posts have expired, so this history is incomplete.</Notice>
      )}
      {posts.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">No posts are kept for this channel.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {posts.map(({ sequence, event }) => {
            const actor = event.metadata.actor;
            const chatId =
              actor &&
              typeof actor === 'object' &&
              !Array.isArray(actor) &&
              typeof actor.chatSessionId === 'string'
                ? actor.chatSessionId
                : null;
            const message =
              typeof event.metadata.message === 'string'
                ? event.metadata.message
                : event.display.summary || '';
            return (
              <li key={event.id} className="flex flex-col gap-1 rounded-lg bg-inset px-3 py-2">
                <span className="text-xs text-fg-muted">
                  #{sequence} · {fullDate(event.receivedAt)}
                  {chatId ? ` · from ${lookups.chatTitle(chatId)}` : ''}
                </span>
                {event.display.title && (
                  <span className="text-sm font-semibold text-fg-primary [overflow-wrap:anywhere]">
                    {event.display.title}
                  </span>
                )}
                <p className="m-0 whitespace-pre-wrap text-sm text-fg-primary [overflow-wrap:anywhere]">
                  {message || 'No message text'}
                </p>
              </li>
            );
          })}
        </ol>
      )}
      {history.hasNextPage && (
        <Button
          variant="ghost"
          className="w-fit"
          loading={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          Show more posts
        </Button>
      )}
    </div>
  );
}

function ChannelRow({
  channel,
  open,
  onToggle,
  lookups,
}: {
  channel: ProjectEventChannel;
  open: boolean;
  onToggle: () => void;
  lookups: AutomationLookups;
}) {
  return (
    <li className="border-0 border-b border-solid border-border-default last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-16 w-full min-w-0 cursor-pointer items-center gap-3 bg-transparent px-4 py-3 text-left hover:bg-surface-hover"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-fg-muted">
          <Hash size={18} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="break-all text-[15px] font-semibold text-fg-primary">
            {channel.name}
          </span>
          <span className="text-[13px] text-fg-muted">
            {channel.lifetimeCount} {channel.lifetimeCount === 1 ? 'post' : 'posts'} · last{' '}
            {relative(channel.lastPublishedAt)}
          </span>
        </span>
        <span className="shrink-0 text-sm font-semibold text-accent">{open ? 'Hide' : 'Read'}</span>
      </button>
      {open && <ChannelHistory channel={channel.name} lookups={lookups} />}
    </li>
  );
}

export function Channels({ lookups }: { lookups: AutomationLookups }) {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const [includeDirect, setIncludeDirect] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const catalog = useQuery({
    ...channelsQueryOptions(queryScope, projectId, includeDirect),
    enabled: Boolean(queryScope),
  });
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-sm text-fg-muted">
        Agents publish here to share progress with each other. Posts come from agents: read them as
        notes, not instructions.
      </p>
      {catalog.isPending ? (
        <Loading label="Loading channels…" />
      ) : catalog.isError ? (
        <LoadError what="channels" error={catalog.error} onRetry={() => void catalog.refetch()} />
      ) : (
        <>
          <Panel className="overflow-hidden" label="Channels">
            {catalog.data.items.length === 0 ? (
              <p className="m-0 p-4 text-sm text-fg-muted">No agent has posted on a channel yet.</p>
            ) : (
              <ul className="m-0 list-none p-0">
                {catalog.data.items.map((channel) => (
                  <ChannelRow
                    key={channel.id}
                    channel={channel}
                    lookups={lookups}
                    open={open === channel.name}
                    onToggle={() =>
                      setOpen((current) => (current === channel.name ? null : channel.name))
                    }
                  />
                ))}
              </ul>
            )}
          </Panel>
          {catalog.data.truncated && (
            <Notice>This project has more channels than fit here, so some are not listed.</Notice>
          )}
        </>
      )}
      <CheckRow
        checked={includeDirect}
        onChange={setIncludeDirect}
        label="Show private threads between agents"
        hint={
          catalog.data?.directSeen
            ? `SAM keeps at least ${catalog.data.directSeen} of these for agent-to-agent messages.`
            : 'SAM keeps these for agent-to-agent messages.'
        }
      />
    </div>
  );
}
