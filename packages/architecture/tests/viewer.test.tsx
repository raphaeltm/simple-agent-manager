import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/client/App';
import type { ViewerModel } from '../src/server/payloads';

class MockEventSource extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    super();
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
    expect(await screen.findByRole('heading', { name: 'Architecture <script>alert(1)</script>' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Flow' }));
    expect(window.location.search).toContain('lens=flow');
    expect(screen.getByText('Call API')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Open in structure' }));
    expect(window.location.search).toContain('focus=api');
    fireEvent.click(screen.getByRole('button', { name: 'Root system' }));
    expect(window.location.search).toContain('focus=root');
  });

  it('opens source previews and creates threads without duplicate submit', async () => {
    const fetchMock = mockFetch(makeModel());
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /API component/ }));
    fireEvent.click(screen.getByRole('button', { name: /src\/api.ts:1/ }));
    expect(await screen.findByLabelText('Source preview')).toHaveTextContent('export const hello');

    fireEvent.change(screen.getByLabelText('Question title'), { target: { value: 'Question' } });
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Body' } });
    const submit = screen.getByRole('button', { name: 'Create question' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/Saved to architecture\/threads/)).toBeVisible());
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/api/threads'))).toHaveLength(1);
  });

  it('preserves mutation drafts after server failure and replies to existing threads', async () => {
    mockFetch(makeModel({ failThreadCreate: true }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /API component/ }));
    fireEvent.change(screen.getByLabelText('Question title'), { target: { value: 'Question' } });
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Draft survives' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create question' }));
    expect(await screen.findByText('Thread failed')).toBeVisible();
    expect(screen.getByLabelText('Question')).toHaveValue('Draft survives');

    fireEvent.change(screen.getByLabelText(/Reply to Existing/), { target: { value: 'Reply draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(screen.getByText(/Saved to architecture\/threads/)).toBeVisible());
  });

  it('supports state lens textual transitions and Escape focus return on mobile inspector', async () => {
    mockFetch(makeModel());
    render(<App />);
    const apiButton = await screen.findByRole('button', { name: /API component/ });
    apiButton.focus();
    fireEvent.click(apiButton);
    expect(screen.getByLabelText('Architecture inspector')).toHaveClass('is-open');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByLabelText('Architecture inspector')).not.toHaveClass('is-open');
    expect(apiButton).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'State' }));
    expect(screen.getByLabelText('Task state transition list')).toHaveTextContent('queued → running when start');
  });

  it('renders empty and many-node states without interpreting special-character text as HTML', async () => {
    mockFetch(makeModel({ many: true }));
    render(<App />);
    expect(await screen.findByText('Architecture <script>alert(1)</script>')).toBeVisible();
    expect(screen.queryByText('alert(1)', { selector: 'script' })).toBeNull();
    expect(screen.getByText('Node 29 with very long https://example.com/path/'.repeat(2))).toBeVisible();
  });
});

function mockFetch(model: ViewerModel & { failThreadCreate?: boolean }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/model')) return jsonResponse(model);
    if (url.includes('/api/elements/')) return jsonResponse({ details: {} });
    if (url.endsWith('/api/source-preview')) {
      return jsonResponse({ preview: { path: 'src/api.ts', startLine: 1, endLine: 1, content: 'export const hello = true;', truncated: false } });
    }
    if (url.endsWith('/api/threads') && init?.method === 'POST') {
      if (model.failThreadCreate) return jsonResponse({ error: { message: 'Thread failed' } }, 500);
      return jsonResponse({ artifactPath: 'architecture/threads/thread-api.thread.md', thread: model.workspace.threads[0] }, 201);
    }
    if (url.includes('/replies')) {
      return jsonResponse({ artifactPath: 'architecture/threads/thread-api.thread.md', message: model.workspace.threads[0]?.messages[0] }, 201);
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

function makeModel(options: { failThreadCreate?: boolean; many?: boolean } = {}): ViewerModel & { failThreadCreate?: boolean } {
  const children = options.many
    ? Array.from({ length: 30 }, (_, index) => ({
        id: `node-${index}`,
        kind: 'component' as const,
        parent: 'root',
        title: index === 29 ? 'Node 29 with very long https://example.com/path/'.repeat(2) : `Node ${index}`,
      }))
    : [{ id: 'api', kind: 'component' as const, parent: 'root', title: 'API component', sourceRefs: [{ path: 'src/api.ts', startLine: 1 }] }];
  return {
    failThreadCreate: options.failThreadCreate,
    diagnostics: [],
    summary: {
      counts: { elements: children.length + 1, flows: 1, relationships: 1, stateMachines: 1, unresolvedThreads: 1, views: 0 },
      name: 'Architecture <script>alert(1)</script>',
      roots: [{ id: 'root', kind: 'system', title: 'Root system' }],
    },
    workspace: {
      elements: [{ id: 'root', kind: 'system', title: 'Root system' }, ...children],
      flows: [{ id: 'flow', title: 'Request flow', steps: [{ id: 'step', title: 'Call API', element: 'api' }] }],
      name: 'Architecture <script>alert(1)</script>',
      relationships: [{ id: 'root-api', from: 'root', to: 'api', title: 'Root calls API' }],
      stateMachines: [{
        element: 'api',
        id: 'task-state',
        title: 'Task state',
        states: [{ id: 'queued', title: 'Queued' }, { id: 'running', title: 'Running' }],
        transitions: [{ from: 'queued', to: 'running', event: 'start' }],
      }],
      threads: [{
        createdAt: '2026-08-13T00:00:00.000Z',
        id: 'thread-api',
        messages: [{ author: 'agent', body: 'Existing body', createdAt: '2026-08-13T00:00:00.000Z', id: 'msg-api' }],
        status: 'unresolved',
        target: 'api',
        title: 'Existing',
        updatedAt: '2026-08-13T00:00:00.000Z',
        version: 1,
      }],
    },
  };
}
