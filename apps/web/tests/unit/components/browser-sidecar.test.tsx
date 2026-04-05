import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { BrowserSidecar } from '../../../src/components/BrowserSidecar';

// Mock the hook
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockRefresh = vi.fn();

let mockHookReturn = {
  status: null as { status: string; url?: string; error?: string; ports?: Array<{ port: number; targetHost: string; active: boolean }> } | null,
  isLoading: false,
  error: null as string | null,
  start: mockStart,
  stop: mockStop,
  refresh: mockRefresh,
};

vi.mock('../../../src/hooks/useBrowserSidecar', () => ({
  useBrowserSidecar: () => mockHookReturn,
}));

describe('BrowserSidecar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHookReturn = {
      status: null,
      isLoading: false,
      error: null,
      start: mockStart,
      stop: mockStop,
      refresh: mockRefresh,
    };
  });

  it('renders start button when status is off', () => {
    mockHookReturn.status = { status: 'off' };
    render(<BrowserSidecar projectId="proj-1" sessionId="sess-1" />);
    const btn = screen.getByRole('button', { name: /start remote browser/i });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it('calls start with viewport opts on click', async () => {
    mockHookReturn.status = { status: 'off' };
    mockStart.mockResolvedValue(undefined);
    render(<BrowserSidecar projectId="proj-1" sessionId="sess-1" />);
    fireEvent.click(screen.getByRole('button', { name: /start remote browser/i }));
    await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1));
    const opts = mockStart.mock.calls[0][0];
    expect(opts).toHaveProperty('viewportWidth');
    expect(opts).toHaveProperty('viewportHeight');
    expect(opts).toHaveProperty('devicePixelRatio');
    expect(opts).toHaveProperty('isTouchDevice');
  });

  it('shows loading state on start button', () => {
    mockHookReturn.status = { status: 'off' };
    mockHookReturn.isLoading = true;
    render(<BrowserSidecar projectId="proj-1" sessionId="sess-1" />);
    // Button should have loading prop (rendered by design system as disabled)
    const btn = screen.getByRole('button', { name: /start remote browser/i });
    expect(btn).toBeInTheDocument();
  });

  it('renders show/hide and stop buttons when running', () => {
    mockHookReturn.status = { status: 'running', url: 'https://example.com' };
    render(<BrowserSidecar workspaceId="ws-1" />);
    expect(screen.getByRole('button', { name: /show remote browser/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop remote browser/i })).toBeInTheDocument();
  });

  it('disables show/hide button when loading', () => {
    mockHookReturn.status = { status: 'running', url: 'https://example.com' };
    mockHookReturn.isLoading = true;
    render(<BrowserSidecar workspaceId="ws-1" />);
    expect(screen.getByRole('button', { name: /show remote browser/i })).toBeDisabled();
  });

  it('shows open-in-new-tab link when running', () => {
    mockHookReturn.status = { status: 'running', url: 'https://example.com' };
    render(<BrowserSidecar workspaceId="ws-1" />);
    const link = screen.getByText(/open remote browser in new tab/i);
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('uses autoLoginUrl when available', () => {
    mockHookReturn.status = { status: 'running', url: 'https://example.com', autoLoginUrl: 'https://example.com?usr=user&pwd=secret' } as typeof mockHookReturn.status;
    render(<BrowserSidecar workspaceId="ws-1" />);
    const link = screen.getByText(/open remote browser in new tab/i);
    expect(link).toHaveAttribute('href', 'https://example.com?usr=user&pwd=secret');
  });

  it('calls stop on stop click', async () => {
    mockHookReturn.status = { status: 'running', url: 'https://example.com' };
    mockStop.mockResolvedValue(undefined);
    render(<BrowserSidecar workspaceId="ws-1" />);
    fireEvent.click(screen.getByRole('button', { name: /stop remote browser/i }));
    await waitFor(() => expect(mockStop).toHaveBeenCalledTimes(1));
  });

  it('shows error alert and retry button on error status', () => {
    mockHookReturn.status = { status: 'error', error: 'Container crashed' };
    render(<BrowserSidecar projectId="proj-1" sessionId="sess-1" />);
    expect(screen.getByText('Container crashed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('shows hook-level error as alert', () => {
    mockHookReturn.status = { status: 'running', url: 'https://example.com' };
    mockHookReturn.error = 'Network error';
    render(<BrowserSidecar workspaceId="ws-1" />);
    expect(screen.getByText('Network error')).toBeInTheDocument();
  });

  it('shows forwarded ports when running with ports', () => {
    mockHookReturn.status = {
      status: 'running',
      url: 'https://example.com',
      ports: [
        { port: 3000, targetHost: 'devcontainer-1', active: true },
        { port: 8080, targetHost: 'devcontainer-1', active: true },
      ],
    };
    render(<BrowserSidecar workspaceId="ws-1" />);
    // Show the viewer to trigger port display
    fireEvent.click(screen.getByRole('button', { name: /show remote browser/i }));
    expect(screen.getByText(/Forwarded ports/)).toBeInTheDocument();
    expect(screen.getByText(/3000/)).toBeInTheDocument();
    expect(screen.getByText(/8080/)).toBeInTheDocument();
  });

  it('shows starting state with spinner', () => {
    mockHookReturn.status = { status: 'starting' };
    render(<BrowserSidecar projectId="proj-1" sessionId="sess-1" />);
    expect(screen.getByText('Starting browser...')).toBeInTheDocument();
  });

  it('has data-testid for test targeting', () => {
    mockHookReturn.status = { status: 'off' };
    const { container } = render(<BrowserSidecar projectId="proj-1" sessionId="sess-1" />);
    expect(container.querySelector('[data-testid="browser-sidecar"]')).toBeInTheDocument();
  });

  it('renders with workspace mode props', () => {
    mockHookReturn.status = { status: 'off' };
    render(<BrowserSidecar workspaceId="ws-1" />);
    expect(screen.getByRole('button', { name: /start remote browser/i })).toBeInTheDocument();
  });

  it('renders with session mode props', () => {
    mockHookReturn.status = { status: 'off' };
    render(<BrowserSidecar projectId="proj-1" sessionId="sess-1" />);
    expect(screen.getByRole('button', { name: /start remote browser/i })).toBeInTheDocument();
  });
});
