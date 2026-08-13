import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/client/App';
import type { ViewerModel } from '../src/server/payloads';

class MockEventSource extends EventTarget {
  static latest?: MockEventSource;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(readonly url: string) {
    super();
    MockEventSource.latest = this;
  }
  close() {}
}

describe('architecture viewer', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('navigates URL-addressable lenses and drills with breadcrumbs', async () => {
    mockFetch(makeModel());
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Architecture <script>alert(1)</script>' })
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Flow' }));
    expect(window.location.search).toContain('lens=flow');
    expect(screen.getByText('Call API')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Open API component in structure' }));
    expect(window.location.search).toContain('focus=api');
    fireEvent.click(screen.getByRole('button', { name: 'Root system' }));
    expect(window.location.search).toContain('focus=root');
  });

  it('opens source previews and creates threads without duplicate submit', async () => {
    const fetchMock = mockFetch(makeModel());
    render(<App />);
    fireEvent.click((await screen.findByText('API component')).closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: /src\/api.ts:1/ }));
    expect(await screen.findByLabelText('Source preview')).toHaveTextContent('export const hello');

    fireEvent.change(screen.getByLabelText('Question title'), { target: { value: 'Question' } });
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Body' } });
    const submit = screen.getByRole('button', { name: 'Create question' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/Saved to architecture\/threads/)).toBeVisible());
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/api/threads'))
    ).toHaveLength(1);
  });

  it('preserves mutation drafts after server failure and replies to existing threads', async () => {
    mockFetch(makeModel({ failThreadCreate: true }));
    render(<App />);
    fireEvent.click((await screen.findByText('API component')).closest('button')!);
    fireEvent.change(screen.getByLabelText('Question title'), { target: { value: 'Question' } });
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Draft survives' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create question' }));
    expect(await screen.findByText('Thread failed')).toBeVisible();
    expect(screen.getByLabelText('Question')).toHaveValue('Draft survives');

    fireEvent.change(screen.getByLabelText(/Reply to Existing/), {
      target: { value: 'Reply draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(screen.getByText(/Saved to architecture\/threads/)).toBeVisible());
  });

  it('supports state lens textual transitions and Escape focus return on mobile inspector', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width') }));
    mockFetch(makeModel());
    render(<App />);
    const apiButton = (await screen.findByText('API component')).closest('button')!;
    apiButton.focus();
    fireEvent.click(apiButton);
    expect(screen.getByLabelText('Architecture inspector')).toHaveClass('is-open');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByLabelText('Architecture inspector')).not.toHaveClass('is-open');
    expect(apiButton).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'State' }));
    expect(screen.getByLabelText('Task state transition list')).toHaveTextContent('Queued');
    expect(screen.getByLabelText('Queued when start goes to Running')).toBeVisible();
  });

  it('renders State as a human-titled route atlas across branches, cycles, and missing data', async () => {
    const model = makeModel();
    model.workspace.stateMachines = [
      {
        element: 'api',
        id: 'route-atlas',
        title: 'Route atlas',
        states: [
          { id: 'first-state', title: 'First state' },
          { id: 'second-state', title: 'Second state' },
          { id: 'quiet-state', title: 'Quiet state' },
        ],
        transitions: [
          { from: 'first-state', to: 'second-state' },
          { from: 'first-state', to: 'missing-state', event: 'branch_to_missing' },
          { from: 'second-state', to: 'first-state', event: 'cycle-back' },
        ],
      },
    ];
    mockFetch(model);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'State' }));

    expect(
      screen.getByLabelText('First state when no event specified goes to Second state')
    ).toBeVisible();
    expect(
      screen.getByLabelText('First state when branch to missing goes to missing-state')
    ).toBeVisible();
    expect(screen.getByLabelText('Second state when cycle back goes to First state')).toBeVisible();
    expect(screen.getByText('No outgoing transitions in this view.')).toBeVisible();
  });

  it('preserves target-specific drafts and ignores a stale source response after selection changes', async () => {
    let resolveSource: ((value: Response) => void) | undefined;
    const sourceResponse = new Promise<Response>((resolve) => {
      resolveSource = resolve;
    });
    mockFetch(makeModel(), sourceResponse);
    render(<App />);
    fireEvent.click((await screen.findByText('API component')).closest('button')!);
    fireEvent.change(screen.getByLabelText('Question title'), { target: { value: 'Stale title' } });
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Stale body' } });
    fireEvent.click(screen.getByRole('button', { name: /src\/api.ts:1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Root system' }));
    resolveSource?.(
      jsonResponse({
        preview: {
          path: 'src/api.ts',
          startLine: 1,
          endLine: 1,
          content: 'stale preview',
          truncated: false,
        },
      })
    );
    await Promise.resolve();
    expect(screen.queryByText('stale preview')).toBeNull();
    expect(screen.getByLabelText('Question title')).toHaveValue('');
    expect(screen.getByLabelText('Question')).toHaveValue('');
    fireEvent.click(screen.getByText('API component').closest('button')!);
    expect(screen.getByLabelText('Question title')).toHaveValue('Stale title');
    expect(screen.getByLabelText('Question')).toHaveValue('Stale body');
  });

  it('keeps the newest source preview when same-target requests resolve out of order', async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    let resolveSecond: ((value: Response) => void) | undefined;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    const model = makeModel();
    const api = model.workspace.elements.find((element) => element.id === 'api');
    api?.sourceRefs?.push({ path: 'src/worker.ts', startLine: 8 });
    mockFetch(model, [first, second]);
    render(<App />);
    fireEvent.click((await screen.findByText('API component')).closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: /src\/api.ts:1/ }));
    fireEvent.click(screen.getByRole('button', { name: /src\/worker.ts:8/ }));
    resolveSecond?.(
      jsonResponse({
        preview: {
          path: 'src/worker.ts',
          startLine: 8,
          endLine: 8,
          content: 'newest preview',
          truncated: false,
        },
      })
    );
    expect(await screen.findByText('newest preview')).toBeVisible();
    resolveFirst?.(
      jsonResponse({
        preview: {
          path: 'src/api.ts',
          startLine: 1,
          endLine: 1,
          content: 'stale same-target preview',
          truncated: false,
        },
      })
    );
    await Promise.resolve();
    expect(screen.queryByText('stale same-target preview')).toBeNull();
  });

  it('keeps a successful mutation visible when the follow-up model refresh fails', async () => {
    mockFetch(makeModel({ failReloadAfterThread: true }));
    render(<App />);
    fireEvent.click((await screen.findByText('API component')).closest('button')!);
    fireEvent.change(screen.getByLabelText('Question title'), { target: { value: 'Question' } });
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Saved body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create question' }));
    expect(await screen.findByText(/Saved to architecture\/threads/)).toBeVisible();
    expect(await screen.findByText(/Saved, but the view could not refresh/)).toBeVisible();
  });

  it('runs a queued refresh after the active refresh fails', async () => {
    const initial = makeModel();
    const recovered = makeModel();
    recovered.workspace.name = 'Recovered architecture';
    recovered.summary.name = 'Recovered architecture';
    let resolveFailedRefresh: ((value: Response) => void) | undefined;
    const failedRefresh = new Promise<Response>((resolve) => {
      resolveFailedRefresh = resolve;
    });
    const responses = [jsonResponse(initial), failedRefresh, jsonResponse(recovered)];
    const fetchMock = vi.fn(() => responses.shift() ?? jsonResponse(recovered));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByRole('heading', { name: initial.summary.name })).toBeVisible();
    act(() => MockEventSource.latest?.dispatchEvent(new Event('architecture:model')));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    act(() => MockEventSource.latest?.dispatchEvent(new Event('architecture:model')));
    resolveFailedRefresh?.(jsonResponse({ error: { message: 'Transient reload failure' } }, 500));

    expect(await screen.findByRole('heading', { name: 'Recovered architecture' })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/Transient reload failure/)).toBeNull();
  });

  it('does not let an older model response erase a newer invalid-workspace event', async () => {
    const initial = makeModel();
    const stale = makeModel();
    stale.workspace.name = 'Stale response';
    stale.summary.name = 'Stale response';
    let resolveStaleRefresh: ((value: Response) => void) | undefined;
    const staleRefresh = new Promise<Response>((resolve) => {
      resolveStaleRefresh = resolve;
    });
    const responses = [jsonResponse(initial), staleRefresh];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => responses.shift() ?? jsonResponse(stale))
    );

    render(<App />);
    expect(await screen.findByRole('heading', { name: initial.summary.name })).toBeVisible();
    act(() => MockEventSource.latest?.dispatchEvent(new Event('architecture:model')));
    act(() => MockEventSource.latest?.dispatchEvent(new Event('architecture:invalid')));
    resolveStaleRefresh?.(jsonResponse(stale));

    expect(await screen.findByRole('heading', { name: 'Stale response' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid workspace edit detected');
  });

  it('does not let an older model response erase a newer reconnecting state', async () => {
    const initial = makeModel();
    let resolveStaleRefresh: ((value: Response) => void) | undefined;
    const staleRefresh = new Promise<Response>((resolve) => {
      resolveStaleRefresh = resolve;
    });
    const responses = [jsonResponse(initial), staleRefresh];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => responses.shift() ?? jsonResponse(initial))
    );

    render(<App />);
    expect(await screen.findByRole('heading', { name: initial.summary.name })).toBeVisible();
    act(() => MockEventSource.latest?.dispatchEvent(new Event('architecture:model')));
    act(() => MockEventSource.latest?.onerror?.());
    resolveStaleRefresh?.(jsonResponse(initial));

    expect(await screen.findByRole('alert')).toHaveTextContent('live updates are reconnecting');
    expect(
      screen.getByText(/live updates are reconnecting/, { selector: '[role="status"]' })
    ).toBeVisible();
  });

  it('reloads the model on SSE reconnect so missed file edits converge', async () => {
    const initial = makeModel();
    const reconnected = makeModel();
    reconnected.workspace.name = 'Agent reply received';
    reconnected.summary.name = 'Agent reply received';
    const responses = [jsonResponse(initial), jsonResponse(reconnected)];
    const fetchMock = vi.fn(() => responses.shift() ?? jsonResponse(reconnected));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByRole('heading', { name: initial.summary.name })).toBeVisible();
    act(() => MockEventSource.latest?.onerror?.());
    act(() => MockEventSource.latest?.onopen?.());

    expect(await screen.findByRole('heading', { name: 'Agent reply received' })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('preserves reconnecting state when the initial model request fails', async () => {
    let rejectInitial: ((reason?: unknown) => void) | undefined;
    const initial = new Promise<Response>((_resolve, reject) => {
      rejectInitial = reject;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => initial)
    );

    render(<App />);
    act(() => MockEventSource.latest?.onerror?.());
    rejectInitial?.(new Error('Initial model failed'));

    expect(await screen.findByRole('heading', { name: 'Invalid workspace' })).toBeVisible();
    expect(
      screen.getByText(/live updates are reconnecting/, { selector: '[role="status"]' })
    ).toBeVisible();
  });

  it('does not duplicate the model request on initial SSE connection', async () => {
    const fetchMock = mockFetch(makeModel());
    render(<App />);
    expect(await screen.findByRole('heading', { name: /Architecture/ })).toBeVisible();

    act(() => MockEventSource.latest?.onopen?.());
    await Promise.resolve();

    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/api/model'))
    ).toHaveLength(1);
  });

  it('restores lens, focus, and selection from browser history', async () => {
    mockFetch(makeModel());
    render(<App />);
    expect(await screen.findByText('API component')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Flow' }));
    const flowUrl = window.location.href;
    fireEvent.click(screen.getByRole('button', { name: 'Open API component in structure' }));
    expect(window.location.search).toContain('focus=api');

    window.history.replaceState(null, '', flowUrl);
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));

    expect(screen.getByRole('button', { name: 'Flow' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Call API')).toBeVisible();
  });

  it('shows bounded empty scoped lenses, hides inapplicable zoom, and exposes SSE status', async () => {
    const model = makeModel();
    model.workspace.elements.push({
      id: 'isolated',
      kind: 'component',
      parent: 'root',
      title: 'Isolated',
    });
    window.history.replaceState(null, '', '/?lens=flow&focus=isolated');
    mockFetch(model);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'No flows in this scope' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull();

    act(() => MockEventSource.latest?.dispatchEvent(new Event('architecture:invalid')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid workspace edit detected');
    act(() => MockEventSource.latest?.onerror?.());
    expect(await screen.findByRole('alert')).toHaveTextContent('SSE reconnecting');
    act(() => MockEventSource.latest?.onopen?.());
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    await waitFor(() =>
      expect(
        screen.getByText('Architecture model loaded.', { selector: '[role="status"]' })
      ).toBeVisible()
    );
  });

  it('renders empty and many-node states without interpreting special-character text as HTML', async () => {
    mockFetch(makeModel({ many: true }));
    render(<App />);
    expect(await screen.findByText('Architecture <script>alert(1)</script>')).toBeVisible();
    expect(screen.queryByText('alert(1)', { selector: 'script' })).toBeNull();
    expect(
      screen.getByText('Node 29 with very long https://example.com/path/'.repeat(2))
    ).toBeVisible();
  });

  it('collapses deeply nested breadcrumbs to a bounded focusable window', async () => {
    const model = makeModel();
    model.workspace.elements = Array.from({ length: 50 }, (_, index) => ({
      id: `depth-${index}`,
      kind: 'component' as const,
      parent: index === 0 ? undefined : `depth-${index - 1}`,
      title: `Depth ${index}`,
    }));
    model.summary.roots = model.workspace.elements.slice(0, 1);
    model.summary.counts.elements = model.workspace.elements.length;
    window.history.replaceState(null, '', '/?lens=structure&focus=depth-49');
    mockFetch(model);

    render(<App />);
    const breadcrumbs = await screen.findByRole('navigation', { name: 'Breadcrumbs' });

    expect(within(breadcrumbs).getAllByRole('button')).toHaveLength(model.limits.breadcrumbs);
    expect(within(breadcrumbs).getByRole('button', { name: 'Depth 0' })).toBeVisible();
    expect(within(breadcrumbs).getByRole('button', { name: 'Depth 49' })).toBeVisible();
    expect(within(breadcrumbs).getByLabelText('43 intermediate scopes omitted')).toBeVisible();
  });

  it('inspects and authors a thread on a relationship target', async () => {
    const fetchMock = mockFetch(makeModel());
    render(<App />);
    const portals = await screen.findByRole('region', { name: 'Cross-scope portal relationships' });
    fireEvent.click(within(portals).getByRole('button', { name: 'Root calls API' }));
    expect(screen.getByRole('heading', { name: 'Root calls API' })).toBeVisible();
    expect(screen.getByText('root → api')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Question title'), {
      target: { value: 'Relationship question' },
    });
    fireEvent.change(screen.getByLabelText('Question'), {
      target: { value: 'Does this edge retry?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create question' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => {
          if (!String(call[0]).endsWith('/api/threads')) return false;
          return String(call[1]?.body).includes('"target":"root-api"');
        })
      ).toBe(true)
    );
  });
});

function mockFetch(
  model: ViewerModel & { failReloadAfterThread?: boolean; failThreadCreate?: boolean },
  sourceResponse?: Promise<Response> | Promise<Response>[]
) {
  let sourceRequest = 0;
  let threadCreated = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/model')) {
      if (model.failReloadAfterThread && threadCreated) {
        return jsonResponse({ error: { message: 'Refresh failed' } }, 500);
      }
      return jsonResponse(model);
    }
    if (url.includes('/api/elements/')) return jsonResponse({ details: {} });
    if (url.endsWith('/api/source-preview')) {
      if (Array.isArray(sourceResponse)) return sourceResponse[sourceRequest++]!;
      if (sourceResponse) return sourceResponse;
      return jsonResponse({
        preview: {
          path: 'src/api.ts',
          startLine: 1,
          endLine: 1,
          content: 'export const hello = true;',
          truncated: false,
        },
      });
    }
    if (url.endsWith('/api/threads') && init?.method === 'POST') {
      if (model.failThreadCreate) return jsonResponse({ error: { message: 'Thread failed' } }, 500);
      threadCreated = true;
      return jsonResponse(
        {
          artifactPath: 'architecture/threads/thread-api.thread.md',
          thread: model.workspace.threads[0],
        },
        201
      );
    }
    if (url.includes('/replies')) {
      return jsonResponse(
        {
          artifactPath: 'architecture/threads/thread-api.thread.md',
          message: model.workspace.threads[0]?.messages[0],
        },
        201
      );
    }
    return jsonResponse({ error: { message: 'Unexpected request' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function makeModel(
  options: { failReloadAfterThread?: boolean; failThreadCreate?: boolean; many?: boolean } = {}
): ViewerModel & { failReloadAfterThread?: boolean; failThreadCreate?: boolean } {
  const children = options.many
    ? Array.from({ length: 30 }, (_, index) => ({
        id: `node-${index}`,
        kind: 'component' as const,
        parent: 'root',
        title:
          index === 29
            ? 'Node 29 with very long https://example.com/path/'.repeat(2)
            : `Node ${index}`,
      }))
    : [
        {
          id: 'api',
          kind: 'component' as const,
          parent: 'root',
          title: 'API component',
          sourceRefs: [{ path: 'src/api.ts', startLine: 1 }],
        },
      ];
  return {
    failThreadCreate: options.failThreadCreate,
    failReloadAfterThread: options.failReloadAfterThread,
    diagnostics: [],
    limits: {
      breadcrumbs: 7,
      children: 80,
      flowSteps: 50,
      flows: 30,
      relationships: 120,
      stateMachines: 30,
      states: 50,
      transitions: 80,
    },
    interaction: {
      maxZoom: 1.5,
      minZoom: 0.75,
      mobileBreakpointPx: 760,
      panPixels: 48,
      zoomStep: 0.125,
    },
    summary: {
      counts: {
        elements: children.length + 1,
        flows: 1,
        relationships: 1,
        stateMachines: 1,
        unresolvedThreads: 1,
        views: 0,
      },
      name: 'Architecture <script>alert(1)</script>',
      roots: [{ id: 'root', kind: 'system', title: 'Root system' }],
      truncated: { roots: 0 },
    },
    workspace: {
      elements: [{ id: 'root', kind: 'system', title: 'Root system' }, ...children],
      flows: [
        {
          id: 'flow',
          title: 'Request flow',
          steps: [{ id: 'step', title: 'Call API', element: 'api' }],
        },
      ],
      name: 'Architecture <script>alert(1)</script>',
      relationships: [{ id: 'root-api', from: 'root', to: 'api', title: 'Root calls API' }],
      stateMachines: [
        {
          element: 'api',
          id: 'task-state',
          title: 'Task state',
          states: [
            { id: 'queued', title: 'Queued' },
            { id: 'running', title: 'Running' },
          ],
          transitions: [{ from: 'queued', to: 'running', event: 'start' }],
        },
      ],
      threads: [
        {
          createdAt: '2026-08-13T00:00:00.000Z',
          id: 'thread-api',
          messages: [
            {
              author: 'agent',
              body: 'Existing body',
              createdAt: '2026-08-13T00:00:00.000Z',
              id: 'msg-api',
            },
          ],
          status: 'unresolved',
          target: 'api',
          title: 'Existing',
          updatedAt: '2026-08-13T00:00:00.000Z',
          version: 1,
        },
      ],
    },
  };
}
