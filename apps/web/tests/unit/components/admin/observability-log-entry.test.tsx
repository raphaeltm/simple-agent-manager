import type { PlatformError } from '@simple-agent-manager/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

describe('ObservabilityLogEntry', () => {
  it('should render error message', () => {
    render(<ObservabilityLogEntry error={createEntry()} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('should render source badge', () => {
    render(<ObservabilityLogEntry error={createEntry({ source: 'vm-agent' })} />);
    expect(screen.getByText('vm-agent')).toBeInTheDocument();
  });

  it('should render level badge', () => {
    render(<ObservabilityLogEntry error={createEntry({ level: 'warn' })} />);
    expect(screen.getByText('warn')).toBeInTheDocument();
  });

  it('renders the batched automatic evidence state', () => {
    render(
      <ObservabilityLogEntry
        error={createEntry({
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
        })}
      />
    );
    expect(screen.getByLabelText('Automatic VM evidence: pending')).toHaveTextContent(
      'evidence pending'
    );
  });

  it('should render formatted timestamp', () => {
    render(<ObservabilityLogEntry error={createEntry()} />);
    // Should show some date representation — exact format depends on locale
    const timestamp = screen.getByText(/Feb/i);
    expect(timestamp).toBeInTheDocument();
  });

  it('should show metadata row when userId/nodeId/workspaceId present', () => {
    render(
      <ObservabilityLogEntry
        error={createEntry({
          userId: 'user-123',
          nodeId: 'node-456',
          workspaceId: 'ws-789',
        })}
      />
    );
    expect(screen.getByText(/user: user-123/)).toBeInTheDocument();
    expect(screen.getByText(/node: node-456/)).toBeInTheDocument();
    expect(screen.getByText(/ws: ws-789/)).toBeInTheDocument();
  });

  it('should not show metadata row when no IDs present', () => {
    render(<ObservabilityLogEntry error={createEntry()} />);
    expect(screen.queryByText(/user:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/node:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ws:/)).not.toBeInTheDocument();
  });

  it('should expand stack trace on click when stack is present', () => {
    const stack = 'Error: test\n  at main.js:42';
    render(<ObservabilityLogEntry error={createEntry({ stack })} />);

    // Stack should not be visible initially
    expect(screen.queryByText(/at main.js:42/)).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByRole('button'));

    // Stack should now be visible
    expect(screen.getByText(/at main.js:42/)).toBeInTheDocument();
  });

  it('should show context JSON when expanded', () => {
    const context = { phase: 'upload', retries: 3 };
    render(<ObservabilityLogEntry error={createEntry({ context })} />);

    // Click to expand
    fireEvent.click(screen.getByRole('button'));

    // Context should be visible as JSON
    expect(screen.getByText(/"phase": "upload"/)).toBeInTheDocument();
    expect(screen.getByText(/"retries": 3/)).toBeInTheDocument();
  });

  it('should not be clickable when no stack or context', () => {
    render(<ObservabilityLogEntry error={createEntry()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('calls the row diagnosis action without toggling details', () => {
    const onDiagnose = vi.fn();
    const entry = createEntry({ stack: 'Error stack' });
    render(<ObservabilityLogEntry error={entry} onDiagnose={onDiagnose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Diagnose' }));
    expect(onDiagnose).toHaveBeenCalledWith(entry);
    expect(screen.queryByText('Error stack')).not.toBeInTheDocument();
  });

  it('should collapse details on second click', () => {
    const stack = 'Error: test\n  at main.js:42';
    render(<ObservabilityLogEntry error={createEntry({ stack })} />);

    const button = screen.getByRole('button');

    // Expand
    fireEvent.click(button);
    expect(screen.getByText(/at main.js:42/)).toBeInTheDocument();

    // Collapse
    fireEvent.click(button);
    expect(screen.queryByText(/at main.js:42/)).not.toBeInTheDocument();
  });
});
