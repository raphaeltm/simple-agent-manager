import { Alert, Button } from '@simple-agent-manager/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { request } from '../../lib/api/client';
import { RenderedMarkdown } from '../MarkdownRenderer';

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
      className="min-w-0 rounded-lg border border-border-default p-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">Earlier SAM history</summary>
      <p className="mt-2 text-xs text-fg-muted">
        Read-only messages from your earlier conversation. Current actions and status appear below.
      </p>
      {open && (
        <div className="mt-3 space-y-4">
          {history.isPending && <p role="status">Loading earlier history…</p>}
          {history.error && (
            <Alert variant="error">
              {history.error.message}{' '}
              <Button variant="secondary" onClick={() => void history.refetch()}>
                Retry earlier history
              </Button>
            </Alert>
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
                {message.role === 'user' ? 'You' : 'SAM'} · Earlier history
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
