import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatBrowserPanel } from '../../../../src/components/chat/ChatBrowserPanel';

// Mock BrowserSidecar to avoid deep dependency tree
vi.mock('../../../../src/components/BrowserSidecar', () => ({
  BrowserSidecar: ({ projectId, sessionId }: { projectId: string; sessionId: string }) => (
    <div data-testid="browser-sidecar-mock">
      Browser for project={projectId} session={sessionId}
    </div>
  ),
}));

describe('ChatBrowserPanel', () => {
  const defaultProps = {
    projectId: 'proj-123',
    sessionId: 'sess-456',
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the panel with header and browser sidecar', () => {
    render(<ChatBrowserPanel {...defaultProps} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Remote Browser')).toBeInTheDocument();
    expect(screen.getByTestId('browser-sidecar-mock')).toBeInTheDocument();
    expect(screen.getByTestId('browser-sidecar-mock')).toHaveTextContent(
      'Browser for project=proj-123 session=sess-456',
    );
  });

  it('calls onClose when close button is clicked', () => {
    render(<ChatBrowserPanel {...defaultProps} />);

    const closeButton = screen.getByLabelText('Close browser panel');
    fireEvent.click(closeButton);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed', () => {
    render(<ChatBrowserPanel {...defaultProps} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    render(<ChatBrowserPanel {...defaultProps} />);

    // The backdrop is the first child — a div with aria-hidden
    const backdrop = document.querySelector('[aria-hidden="true"]');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('renders with correct panel width class for desktop', () => {
    render(<ChatBrowserPanel {...defaultProps} />);

    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain('md:w-[min(720px,60vw)]');
  });

  it('has aria-modal and aria-label for accessibility', () => {
    render(<ChatBrowserPanel {...defaultProps} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Remote browser');
  });
});
