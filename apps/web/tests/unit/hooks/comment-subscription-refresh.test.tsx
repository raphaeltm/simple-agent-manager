import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useChatWebSocket } from '../../../src/hooks/useChatWebSocket';
import { useProjectWebSocket } from '../../../src/hooks/useProjectWebSocket';
import {
  applyMessageCommentRealtimeEventToQueryCache,
  messageCommentQueryKeys,
  messageCommentsQueryOptions,
} from '../../../src/lib/query-options/comments';

const boundary = vi.hoisted(() => ({ listMessageComments: vi.fn() }));
vi.mock('../../../src/lib/api/comments', async (original) => ({
  ...(await original<typeof import('../../../src/lib/api/comments')>()),
  listMessageComments: boundary.listMessageComments,
}));

vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'viewer' }));
vi.mock('../../../src/lib/api', () => ({ getChatSession: vi.fn() }));

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror = null;
  send = vi.fn();
  close = vi.fn();
  constructor(_url: string) {
    Socket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  Socket.instances = [];
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

for (const transport of ['project', 'session', 'both'] as const) {
  describe(`${transport} socket comment catch-up`, () => {
    it.each(['success', 'failure'])(
      '%s: joins an initial read and repairs withheld changes without inactive or cross-scope reads',
      async (initialResult) => {
        vi.stubGlobal('WebSocket', Socket);
        const client = new QueryClient({
          defaultOptions: { queries: { retry: false, staleTime: Infinity } },
        });
        const initial = deferred<string[]>();
        const refreshed = deferred<string[]>();
        const read = vi
          .fn()
          .mockReturnValueOnce(initial.promise)
          .mockReturnValue(refreshed.promise);
        const key = messageCommentQueryKeys.session('viewer', 'project', 'session');
        const controls = [
          messageCommentQueryKeys.session('other-user', 'project', 'session'),
          messageCommentQueryKeys.session('viewer', 'other-project', 'session'),
          messageCommentQueryKeys.session('viewer', 'project', 'inactive-session'),
        ];
        controls.forEach((control) => client.setQueryData(control, ['unchanged']));
        const wrapper = ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        const hook = renderHook(
          () => {
            const comments = useQuery({ queryKey: key, queryFn: read });
            useProjectWebSocket({ projectId: transport === 'session' ? 'unrelated' : 'project' });
            useChatWebSocket({
              projectId: 'project',
              sessionId: 'session',
              enabled: transport !== 'project',
              onMessage: vi.fn(),
              onSessionStopped: vi.fn(),
              onCatchUp: vi.fn(),
            });
            return comments.data;
          },
          { wrapper }
        );
        await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        act(() => Socket.instances.forEach((socket) => socket.open()));
        expect(read).toHaveBeenCalledTimes(1);
        await act(async () => {
          if (initialResult === 'success') initial.resolve(['stale']);
          else initial.reject(new Error('initial query failed'));
          await initial.promise.catch(() => undefined);
        });
        await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        await act(async () => {
          refreshed.resolve(['created', 'replied', 'resolved']);
          await refreshed.promise;
        });
        await waitFor(() =>
          expect(hook.result.current).toEqual(['created', 'replied', 'resolved'])
        );
        controls.forEach((control) => expect(client.getQueryData(control)).toEqual(['unchanged']));
        expect(client.getQueryState(controls[0]!)?.isInvalidated).toBe(false);
        expect(client.getQueryState(controls[1]!)?.isInvalidated).toBe(false);
        expect(client.getQueryState(controls[2]!)?.isInvalidated).toBe(transport !== 'session');
        expect(read).toHaveBeenCalledTimes(2);
        const reconnect = deferred<string[]>();
        read.mockReturnValue(reconnect.promise);
        act(() => Socket.instances.forEach((socket) => socket.onclose?.({ code: 1006 })));
        await waitFor(
          () => expect(Socket.instances.length).toBeGreaterThan(transport === 'project' ? 1 : 2),
          { timeout: 2000 }
        );
        act(() =>
          Socket.instances.slice(transport === 'project' ? 1 : 2).forEach((socket) => socket.open())
        );
        await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
        await act(async () => {
          reconnect.resolve(['after-reconnect']);
          await reconnect.promise;
        });
        await waitFor(() => expect(hook.result.current).toEqual(['after-reconnect']));
        expect(read).toHaveBeenCalledTimes(3);
        hook.unmount();
        client.clear();
      }
    );
  });
}

it('does not launch a delayed refresh after its socket unmounts', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const initial = deferred<string[]>();
  const read = vi.fn().mockReturnValue(initial.promise);
  const key = messageCommentQueryKeys.session('viewer', 'project', 'session');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => {
      useQuery({ queryKey: key, queryFn: read });
      return useProjectWebSocket({ projectId: 'project' });
    },
    { wrapper }
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  act(() => Socket.instances[0]!.open());
  hook.unmount();
  await act(async () => {
    initial.resolve(['stale']);
    await initial.promise;
  });
  expect(read).toHaveBeenCalledTimes(1);
  expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  client.clear();
});

for (const reason of ['thread_created', 'reply_created', 'resolved'] as const) {
  it(`preserves a live ${reason} frame that overtakes the post-subscription comment snapshot`, async () => {
    vi.stubGlobal('WebSocket', Socket);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const wire = {
      id: 'thread-live',
      sessionId: 'session',
      anchor: { kind: 'message', messageId: 'message', quote: null },
      author: { kind: 'human', id: 'viewer', displayName: 'Viewer' },
      body: 'Live comment',
      createdAt: 10,
      updatedAt: 20,
      status: reason === 'resolved' ? 'resolved' : 'open',
      replies:
        reason === 'reply_created'
          ? [
              {
                id: 'reply',
                author: { kind: 'human', id: 'viewer', displayName: 'Viewer' },
                body: 'Live reply',
                createdAt: 20,
              },
            ]
          : [],
    };
    const stale = {
      id: 'thread-live',
      clientId: null,
      projectId: 'project',
      sessionId: 'session',
      anchor: wire.anchor,
      author: { id: 'viewer', kind: 'human' as const, name: 'Viewer' },
      body: 'Old comment',
      createdAt: 10,
      updatedAt: 10,
      status: 'open' as const,
      replies: [],
    };
    const old = reason === 'thread_created' ? [] : [stale];
    const held = deferred<{ comments: typeof old }>();
    boundary.listMessageComments
      .mockReset()
      .mockResolvedValueOnce({ comments: old })
      .mockReturnValueOnce(held.promise);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      () => {
        const query = useQuery(messageCommentsQueryOptions('viewer', 'project', 'session'));
        useProjectWebSocket({
          projectId: 'project',
          onCommentEvent: (event) =>
            applyMessageCommentRealtimeEventToQueryCache(client, 'viewer', event),
        });
        return query.data;
      },
      { wrapper }
    );
    await waitFor(() => expect(hook.result.current).toEqual(old));
    act(() => Socket.instances[0]!.open());
    await waitFor(() => expect(boundary.listMessageComments).toHaveBeenCalledTimes(2));
    act(() =>
      Socket.instances[0]!.onmessage?.({
        data: JSON.stringify({
          type: 'comment.thread.changed',
          payload: { sessionId: 'session', reason, thread: wire },
        }),
      })
    );
    await waitFor(() => expect(hook.result.current?.[0]?.body).toBe('Live comment'));
    await act(async () => {
      held.resolve({ comments: old });
      await held.promise;
    });
    await waitFor(() =>
      expect(
        client.getQueryState(messageCommentQueryKeys.session('viewer', 'project', 'session'))
          ?.fetchStatus
      ).toBe('idle')
    );
    expect(
      client.getQueryData<typeof old>(
        messageCommentQueryKeys.session('viewer', 'project', 'session')
      )?.[0]?.body
    ).toBe('Live comment');
    expect(hook.result.current?.[0]?.body).toBe('Live comment');
    expect(hook.result.current?.[0]?.status).toBe(wire.status);
    expect(hook.result.current?.[0]?.replies).toHaveLength(wire.replies.length);
    expect(boundary.listMessageComments).toHaveBeenCalledTimes(2);
    hook.unmount();
    client.clear();
  });
}

it('keeps authoritative unchanged comment rows and removals, and retires optimistic identities', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = messageCommentQueryKeys.session('viewer', 'project', 'session');
  const thread = (id: string, clientId: string | null = null) => ({
    id,
    clientId,
    projectId: 'project',
    sessionId: 'session',
    anchor: { kind: 'message' as const, messageId: 'message', quote: null },
    author: { id: 'viewer', kind: 'human' as const, name: 'Viewer' },
    body: id,
    createdAt: 10,
    updatedAt: 10,
    status: 'open' as const,
    replies: [],
  });
  const old = thread('unchanged');
  client.setQueryData(key, [old, thread('removed')]);
  const held = deferred<{ comments: ReturnType<typeof thread>[] }>();
  boundary.listMessageComments.mockReset().mockReturnValueOnce(held.promise);
  const pending = client.fetchQuery(messageCommentsQueryOptions('viewer', 'project', 'session'));
  client.setQueryData(key, [old, thread('removed'), thread('optimistic-local', 'mutation')]);
  held.resolve({
    comments: [
      { ...old, body: 'Fresh server body' },
      thread('canonical', 'mutation'),
      thread('server-only'),
    ],
  });
  const rows = await pending;
  expect(rows.find((row) => row.id === 'unchanged')?.body).toBe('Fresh server body');
  expect(rows.some((row) => row.id === 'removed')).toBe(false);
  expect(rows.some((row) => row.id === 'server-only')).toBe(true);
  expect(rows.filter((row) => row.clientId === 'mutation').map((row) => row.id)).toEqual([
    'canonical',
  ]);
  expect(boundary.listMessageComments).toHaveBeenCalledTimes(1);
  client.clear();
});
