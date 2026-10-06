import type { PlatformError } from '@simple-agent-manager/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ObservabilityLogEntry } from '../../../../src/components/admin/ObservabilityLogEntry';

function createEntry(overrides: Partial<PlatformError> = {}): PlatformError {
  return {
    id: 'err-1',
    source: 'client',
    level: 'error',
    message: 'Something went wrong',
    stack: null,
    context: null,
    userId: null,
    nodeId: null,
    workspaceId: null,
    ipAddress: null,
    userAgent: null,
    timestamp: '2026-02-14T12:00:00.000Z',
    ...overrides,
  };
}

function renderEntry(props: {
  error: PlatformError;
  onDiagnose?: (e: PlatformError) => void;
  diagnosed?: boolean;
}) {
  return render(
    <MemoryRouter>
      <ObservabilityLogEntry {...props} />
    </MemoryRouter>,
  );
}

describe('ObservabilityLogEntry', () => {
  let clipboardWriteText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: clipboardWriteText },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders error message', () => {
    renderEntry({ error: createEntry() });
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('renders source badge', () => {
    renderEntry({ error: createEntry({ source: 'vm-agent' }) });
    expect(screen.getByText('vm-agent')).toBeInTheDocument();
  });

  it('renders level badge', () => {
    renderEntry({ error: createEntry({ level: 'warn' }) });
    expect(screen.getByText('warn')).toBeInTheDocument();
  });

  it('renders the batched automatic evidence state as clickable', () => {
    renderEntry({
      error: createEntry({
        incident: {
          id: 'incident-1',
          platformErrorId: 'err-1',
          nodeId: 'node-1',
          workspaceId: null,
          status: 'pending',
          artifactCount: 0,
          totalBytes: 0,
          manifest: null,
          preview: null,
          failureReason: null,
          expiresAt: '2026-08-12T00:00:00.000Z',
          createdAt: '2026-08-05T00:00:00.000Z',
          updatedAt: '2026-08-05T00:00:00.000Z',
          artifacts: [],
        },
      }),
    });
    const badge = screen.getByLabelText(/Toggle incident details/);
    expect(badge).toHaveTextContent('evidence pending');
    fireEvent.click(badge);
    expect(screen.getByText('Automatic VM evidence')).toBeInTheDocument();
  });

  it('renders formatted timestamp', () => {
    renderEntry({ error: createEntry() });
    expect(screen.getByText(/Feb/i)).toBeInTheDocument();
  });

  it('renders ID pills when userId/nodeId/workspaceId present', () => {
    renderEntry({
      error: createEntry({
        userId: 'user-123',
        nodeId: 'node-456',
        workspaceId: 'ws-789',
      }),
    });
    expect(screen.getByTitle(/user: user-123/)).toBeInTheDocument();
    expect(screen.getByTitle(/node: node-456/)).toBeInTheDocument();
    expect(screen.getByTitle(/ws: ws-789/)).toBeInTheDocument();
  });

  it('renders taskId and sessionId pills when present', () => {
    renderEntry({
      error: createEntry({
        taskId: 'task-abc',
        sessionId: 'session-xyz',
      }),
    });
    expect(screen.getByTitle(/task: task-abc/)).toBeInTheDocument();
    expect(screen.getByTitle(/session: session-xyz/)).toBeInTheDocument();
  });

  it('does not render ID pills when no IDs present', () => {
    renderEntry({ error: createEntry() });
    expect(screen.queryByTitle(/user:/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/node:/)).not.toBeInTheDocument();
  });

  it('expands stack trace on expand click', () => {
    const stack = 'Error: test\n  at main.js:42';
    renderEntry({ error: createEntry({ stack }) });

    expect(screen.queryByText(/at main.js:42/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Show error details'));
    expect(screen.getByText(/at main.js:42/)).toBeInTheDocument();
  });

  it('shows context JSON when expanded', () => {
    const context = { phase: 'upload', retries: 3 };
    renderEntry({ error: createEntry({ context }) });

    fireEvent.click(screen.getByLabelText('Show error details'));
    expect(screen.getByText(/"phase": "upload"/)).toBeInTheDocument();
  });

  it('collapses details on second click', () => {
    const stack = 'Error: test\n  at main.js:42';
    renderEntry({ error: createEntry({ stack }) });

    const button = screen.getByLabelText('Show error details');
    fireEvent.click(button);
    expect(screen.getByText(/at main.js:42/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Hide error details'));
    expect(screen.queryByText(/at main.js:42/)).not.toBeInTheDocument();
  });

  it('calls diagnosis action without toggling details', () => {
    const onDiagnose = vi.fn();
    const entry = createEntry({ stack: 'Error stack' });
    renderEntry({ error: entry, onDiagnose });
    fireEvent.click(screen.getByRole('button', { name: 'Diagnose' }));
    expect(onDiagnose).toHaveBeenCalledWith(entry);
    expect(screen.queryByText('Error stack')).not.toBeInTheDocument();
  });

  it('shows diagnosed marker when diagnosed prop is true', () => {
    renderEntry({ error: createEntry(), diagnosed: true });
    expect(screen.getByText('diagnosed')).toBeInTheDocument();
  });

  it('does not show diagnosed marker when diagnosed prop is false', () => {
    renderEntry({ error: createEntry(), diagnosed: false });
    expect(screen.queryByText('diagnosed')).not.toBeInTheDocument();
  });

  describe('copy-as-markdown', () => {
    it('copies full error as markdown on click', async () => {
      const entry = createEntry({
        userId: 'user-1',
        nodeId: 'node-1',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        sessionId: 'session-1',
        stack: 'Error: test\n  at main.js:42',
        context: { path: '/api/test' },
      });
      renderEntry({ error: entry });

      const copyBtn = screen.getByTestId('copy-markdown-btn');
      fireEvent.click(copyBtn);

      expect(clipboardWriteText).toHaveBeenCalledTimes(1);
      const copied = clipboardWriteText.mock.calls[0][0] as string;
      expect(copied).toContain('## SAM Error Report');
      expect(copied).toContain('**Timestamp:** 2026-02-14T12:00:00.000Z');
      expect(copied).toContain('**Source:** client');
      expect(copied).toContain('**Level:** error');
      expect(copied).toContain('Something went wrong');
      expect(copied).toContain('- User: user-1');
      expect(copied).toContain('- Node: node-1');
      expect(copied).toContain('- Workspace: ws-1');
      expect(copied).toContain('- Task: task-1');
      expect(copied).toContain('- Session: session-1');
      expect(copied).toContain('at main.js:42');
      expect(copied).toContain('"path": "/api/test"');
    });

    it('copies minimal markdown for entry with no IDs or stack', () => {
      renderEntry({ error: createEntry() });

      fireEvent.click(screen.getByTestId('copy-markdown-btn'));

      const copied = clipboardWriteText.mock.calls[0][0] as string;
      expect(copied).toContain('## SAM Error Report');
      expect(copied).toContain('Something went wrong');
      expect(copied).not.toContain('**IDs:**');
      expect(copied).not.toContain('**Stack:**');
    });
  });

  describe('ID pill links', () => {
    it('renders node ID with a plain-tap open link to /nodes/:id', () => {
      renderEntry({ error: createEntry({ nodeId: 'node-123' }) });
      const openLink = screen.getByRole('link', { name: /open node node-123/i });
      expect(openLink).toHaveAttribute('href', '/nodes/node-123');
      // Copy remains a separate button so both actions work on touch devices
      const copyPill = screen.getByTitle(/node: node-123/);
      expect(copyPill.tagName).toBe('BUTTON');
    });

    it('renders workspace ID with an open link when projectId is in context', () => {
      renderEntry({
        error: createEntry({
          workspaceId: 'ws-abc',
          context: { projectId: 'proj-1' },
        }),
      });
      const openLink = screen.getByRole('link', { name: /open ws ws-abc/i });
      expect(openLink).toHaveAttribute('href', '/projects/proj-1/workspace/ws-abc');
    });

    it('renders workspace ID as copy-only pill without open link when no projectId', () => {
      renderEntry({
        error: createEntry({ workspaceId: 'ws-abc' }),
      });
      const pill = screen.getByTitle(/ws: ws-abc/);
      expect(pill.tagName).toBe('BUTTON');
      expect(screen.queryByRole('link', { name: /open ws/i })).not.toBeInTheDocument();
    });

    it('copies ID value on pill click', () => {
      renderEntry({ error: createEntry({ userId: 'user-test-id' }) });
      const pill = screen.getByTitle(/user: user-test-id/);
      fireEvent.click(pill);
      expect(clipboardWriteText).toHaveBeenCalledWith('user-test-id');
    });

    it('copy pill click does not navigate when an open link exists', () => {
      renderEntry({ error: createEntry({ nodeId: 'node-123' }) });
      const copyPill = screen.getByTitle(/node: node-123/);
      fireEvent.click(copyPill);
      expect(clipboardWriteText).toHaveBeenCalledWith('node-123');
    });
  });
});
