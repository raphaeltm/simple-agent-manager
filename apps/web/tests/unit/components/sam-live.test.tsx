import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveProgress } from '../../../src/components/sam/LiveProgress';
import {
  applyLiveEvent,
  type LiveEvent,
  type LiveSnapshot,
  takeSseEvents,
  viewFromSnapshot,
} from '../../../src/components/sam/sam-live';
import { describeLiveStep } from '../../../src/components/sam/sam-receipts';
import { useSamLiveTurn } from '../../../src/components/sam/useSamLiveTurn';

const snapshot: LiveSnapshot = {
  turnId: 'turn-1',
  phase: 'thinking',
  elapsedMs: 4_000,
  text: '',
  thinking: null,
  activity: [],
};
const frame = (event: LiveEvent) => `data: ${JSON.stringify(event)}\n\n`;

describe('live turn events', () => {
  it('anchors elapsed time locally and applies deltas in order', () => {
    let view = viewFromSnapshot(snapshot, 10_000);
    expect(view.startedAt).toBe(6_000);
    view = applyLiveEvent(view, { type: 'text', at: 0, text: 'Two tasks ' }, 0)!;
    view = applyLiveEvent(view, { type: 'text', at: 10, text: 'shipped.' }, 0)!;
    expect(view.text).toBe('Two tasks shipped.');
    // A replayed delta overwrites from its offset instead of duplicating text.
    view = applyLiveEvent(view, { type: 'text', at: 10, text: 'finished.' }, 0)!;
    expect(view.text).toBe('Two tasks finished.');
    expect(applyLiveEvent(view, { type: 'text', at: 99, text: 'gap' }, 0)).toBeNull();
    expect(applyLiveEvent(view, { type: 'draft-reset' }, 0)?.text).toBe('');
  });

  it('upserts tool steps by id and keeps their order', () => {
    let view = viewFromSnapshot(snapshot, 0);
    const running = { id: 'a', operation: 'sam_projects_list', state: 'running' as const };
    view = applyLiveEvent(view, { type: 'tool', activity: running }, 0)!;
    view = applyLiveEvent(
      view,
      { type: 'tool', activity: { id: 'b', operation: 'sam_inbox_get', state: 'running' } },
      0
    )!;
    view = applyLiveEvent(
      view,
      { type: 'tool', activity: { ...running, state: 'completed', count: 3 } },
      0
    )!;
    expect(view.activity.map((step) => [step.id, step.state])).toEqual([
      ['a', 'completed'],
      ['b', 'running'],
    ]);
  });

  it('splits complete frames, skips heartbeats and malformed data, and keeps the remainder', () => {
    const buffer = `: ping\n\n${frame({ type: 'phase', phase: 'writing' })}data: {broken\n\ndata: {"type":"thi`;
    const { events, rest } = takeSseEvents(buffer);
    expect(events).toEqual([{ type: 'phase', phase: 'writing' }]);
    expect(rest).toBe('data: {"type":"thi');
  });
});

describe('live step labels', () => {
  const names = new Map([['project-1', 'Website redesign']]);
  it.each([
    [{ state: 'running', target: { limit: 20 } }, 'Looking through your 20 most recent tasks…'],
    [
      { state: 'completed', target: { limit: 20 }, count: 20, more: true },
      'Read 20 recent tasks (more available)',
    ],
    [{ state: 'running', target: { query: 'deploy' } }, 'Searching tasks for “deploy”…'],
    [
      { state: 'completed', target: { projectId: 'project-1' }, count: 1 },
      'Read 1 recent task in Website redesign',
    ],
    [{ state: 'failed', target: {} }, 'Couldn’t finish: looking through your most recent tasks'],
  ] as const)('describes tasks_list %#', (step, expected) => {
    expect(describeLiveStep({ id: 'x', operation: 'sam_tasks_list', ...step }, names)).toBe(
      expected
    );
  });
  it('describes an approval wait and an unknown operation', () => {
    expect(
      describeLiveStep(
        {
          id: 'x',
          operation: 'sam_work_stop',
          state: 'needs_approval',
          target: { projectId: 'gone' },
        },
        names
      )
    ).toBe('Waiting for your OK: preparing to stop work in a project');
    expect(describeLiveStep({ id: 'x', operation: 'sam_new_tool', state: 'running' }, names)).toBe(
      'New tool…'
    );
  });
});

describe('LiveProgress', () => {
  it('leaves steps that wait for the user to their action card instead of repeating them', () => {
    const view = viewFromSnapshot(
      {
        ...snapshot,
        phase: 'working',
        activity: [
          { id: 'a', operation: 'sam_projects_list', state: 'completed', count: 2 },
          { id: 'b', operation: 'sam_work_stop', state: 'needs_approval' },
          { id: 'c', operation: 'sam_chat_start', state: 'uncertain' },
        ],
      },
      Date.now()
    );
    render(<LiveProgress view={view} projectNames={new Map()} />);
    expect(screen.getByRole('list', { name: 'What SAM is doing' })).toHaveTextContent(
      'Listed 2 projects'
    );
    expect(screen.queryByText(/Waiting for your OK/)).toBeNull();
    expect(screen.queryByText(/outcome not confirmed/)).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Working');
  });

  it('names the tools SAM mentions while thinking the way its steps do', () => {
    const view = viewFromSnapshot(
      {
        ...snapshot,
        phase: 'thinking',
        thinking: 'I will call sam_tasks_list after sam_inbox_get, not sam_unknown_tool.',
      },
      Date.now()
    );
    render(<LiveProgress view={view} projectNames={new Map()} />);
    expect(
      screen.getByText('I will call “List tasks” after “Check your inbox”, not sam_unknown_tool.')
    ).toBeInTheDocument();
  });
});

/** A fetch stub whose stream body the test feeds frame by frame. */
function streamingFetch() {
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const encoder = new TextEncoder();
  const fetchMock = vi.fn(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller);
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return {
    fetchMock,
    send: (event: LiveEvent, index = controllers.length - 1) =>
      controllers[index]!.enqueue(encoder.encode(frame(event))),
    close: (index = controllers.length - 1) => controllers[index]!.close(),
  };
}

describe('useSamLiveTurn', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('follows the running turn and refreshes history when a step settles and when it ends', async () => {
    const stream = streamingFetch();
    vi.stubGlobal('fetch', stream.fetchMock);
    const settled = vi.fn();
    const { result } = renderHook(() => useSamLiveTurn('turn-1', settled));
    await waitFor(() => expect(stream.fetchMock).toHaveBeenCalledTimes(1));
    expect(String(stream.fetchMock.mock.calls[0]?.[0])).toContain('/api/sam/turns/turn-1/stream');
    act(() => stream.send({ type: 'snapshot', ...snapshot }));
    await waitFor(() => expect(result.current.streaming).toBe(true));
    act(() => {
      stream.send({
        type: 'tool',
        activity: { id: 'a', operation: 'sam_inbox_get', state: 'running' },
      });
      stream.send({ type: 'text', at: 0, text: 'Nothing needs ' });
    });
    await waitFor(() => expect(result.current.view?.text).toBe('Nothing needs '));
    expect(settled).not.toHaveBeenCalled();
    act(() =>
      stream.send({
        type: 'tool',
        activity: { id: 'a', operation: 'sam_inbox_get', state: 'completed' },
      })
    );
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    act(() => stream.send({ type: 'done', state: 'completed' }));
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    // The live text stays until the refreshed history replaces it.
    expect(result.current.view?.text).toBe('Nothing needs ');
    expect(stream.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the page on polling when the turn is not running in the server object', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useSamLiveTurn('turn-1', vi.fn()));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ view: null, streaming: false });
  });

  it('reconnects after a dropped stream and resynchronises from the new snapshot', async () => {
    const stream = streamingFetch();
    vi.stubGlobal('fetch', stream.fetchMock);
    const { result } = renderHook(() => useSamLiveTurn('turn-1', vi.fn()));
    await waitFor(() => expect(stream.fetchMock).toHaveBeenCalledTimes(1));
    act(() => {
      stream.send({ type: 'snapshot', ...snapshot });
      stream.send({ type: 'text', at: 0, text: 'Half ' });
      stream.close();
    });
    await waitFor(() => expect(stream.fetchMock).toHaveBeenCalledTimes(2), { timeout: 4_000 });
    act(() => stream.send({ type: 'snapshot', ...snapshot, text: 'Half of the answer ' }));
    await waitFor(() => expect(result.current.view?.text).toBe('Half of the answer '));
  });

  it('closes the stream in a hidden tab and reopens it when the tab returns', async () => {
    const stream = streamingFetch();
    vi.stubGlobal('fetch', stream.fetchMock);
    renderHook(() => useSamLiveTurn('turn-1', vi.fn()));
    await waitFor(() => expect(stream.fetchMock).toHaveBeenCalledTimes(1));
    const firstSignal = (stream.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
      .signal!;
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(firstSignal.aborted).toBe(true));
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(stream.fetchMock).toHaveBeenCalledTimes(2));
  });

  it('does not open a stream without a running turn', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useSamLiveTurn(undefined, vi.fn()));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({ view: null, streaming: false });
  });
});
