import { Button } from '@simple-agent-manager/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { request } from '../../lib/api/client';
import { RenderedMarkdown } from '../MarkdownRenderer';
import { RetryAlert } from './RetryAlert';

interface EarlierMessage {
  id: string;
  role: string;
  content: string;
}
interface EarlierHistory {
  messages: EarlierMessage[];
  nextCursor: number | null;
}

export function EarlierSamHistory({ conversationId }: { conversationId: string }) {
  const scope = useQueryScope();
  const [open, setOpen] = useState(false);
  const history = useInfiniteQuery({
    queryKey: ['auth', scope, 'sam', 'earlier-history', conversationId],
    enabled: open,
    initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) =>
      request<EarlierHistory>(
        `/api/sam/conversations/${encodeURIComponent(conversationId)}/messages${pageParam === null ? '' : `?before=${pageParam}`}`,
        { signal }
      ),
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
  });
  const messages =
    history.data?.pages
      .slice()
      .reverse()
      .flatMap((page) => page.messages)
      .filter(
        (message) =>
          !message.id.startsWith('operator:') &&
          (message.role === 'user' || message.role === 'assistant')
      ) ?? [];
  return (
    <details
      className="group min-w-0 rounded-lg border border-border-default bg-surface px-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={16}
          aria-hidden="true"
          className="text-fg-muted transition-transform group-open:rotate-90"
        />
        <span className="font-medium text-fg-primary">Earlier SAM history</span>
      </summary>
      <p className="pb-2 text-xs text-fg-muted">
        Read-only messages from your earlier conversation. Current actions and status appear below.
      </p>
      {open && (
        <div className="space-y-4 pb-3">
          {history.isPending && <p role="status">Loading earlier history…</p>}
          {history.error && (
            <RetryAlert
              error={history.error}
              fallback="Couldn’t load earlier history."
              onRetry={() => void history.refetch()}
            />
          )}
          {history.hasNextPage && (
            <Button
              variant="secondary"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {history.isFetchingNextPage ? 'Loading…' : 'Load earlier history'}
            </Button>
          )}
          {history.data && messages.length === 0 && (
            <p className="text-sm text-fg-muted">
              This history window contains messages already shown in the current conversation.
            </p>
          )}
          {messages.map((message) => (
            <div key={message.id} className="min-w-0 [overflow-wrap:anywhere]">
              <p className="text-xs font-medium text-fg-muted">
                {message.role === 'user' ? 'You' : 'SAM'}
              </p>
              {message.role === 'assistant' ? (
                <RenderedMarkdown content={message.content} inline />
              ) : (
                <p className="whitespace-pre-wrap">{message.content}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
