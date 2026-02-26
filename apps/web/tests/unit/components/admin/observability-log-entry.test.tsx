import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ObservabilityLogEntry } from '../../../../src/components/admin/ObservabilityLogEntry';
import type { PlatformError } from '@simple-agent-manager/shared';

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
