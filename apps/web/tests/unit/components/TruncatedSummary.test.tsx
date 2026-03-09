import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TruncatedSummary } from '../../../src/components/chat/TruncatedSummary';

// Utility: set up a ResizeObserver mock that captures the callback
function mockResizeObserver() {
  let callback: ResizeObserverCallback | null = null;
  class MockResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      callback = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  return {
    trigger: () => {
      act(() => {
        callback?.([], {} as ResizeObserver);
      });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Render the component and simulate text truncation via mocked element dimensions */
function renderWithTruncation(summary: string) {
  const observer = mockResizeObserver();
  const result = render(<TruncatedSummary summary={summary} />);
  const textSpan = result.container.querySelector('.line-clamp-2')!;
  Object.defineProperty(textSpan, 'scrollHeight', { value: 100, configurable: true });
  Object.defineProperty(textSpan, 'clientHeight', { value: 40, configurable: true });
  observer.trigger();
  return result;
}

describe('TruncatedSummary', () => {
  it('renders the summary text with the Summary label', () => {
    mockResizeObserver();
    render(<TruncatedSummary summary="Short summary" />);
    expect(screen.getByText('Summary:')).toBeInTheDocument();
    expect(screen.getByText('Short summary')).toBeInTheDocument();
  });

  it('does not show "Read more" when text fits within 2 lines', () => {
    mockResizeObserver();
    render(<TruncatedSummary summary="Short text" />);
    // In jsdom scrollHeight === clientHeight (both 0), so no truncation detected
    expect(screen.queryByText('Read more')).not.toBeInTheDocument();
  });

  it('applies line-clamp-2 CSS class for truncation', () => {
    mockResizeObserver();
    const { container } = render(<TruncatedSummary summary="Some text" />);
    const textSpan = container.querySelector('.line-clamp-2');
    expect(textSpan).toBeInTheDocument();
    expect(textSpan).toHaveTextContent('Some text');
  });

  it('shows "Read more" when text overflows 2 lines', () => {
    renderWithTruncation('A long summary that overflows.');
    expect(screen.getByText('Read more')).toBeInTheDocument();
  });

  it('opens modal with full text when "Read more" is clicked', async () => {
    const user = userEvent.setup();
    renderWithTruncation('Full summary content here');

    await user.click(screen.getByText('Read more'));

    // Modal should show title and full text
    expect(screen.getByText('Task Summary')).toBeInTheDocument();
    const summaryElements = screen.getAllByText('Full summary content here');
    expect(summaryElements.length).toBeGreaterThanOrEqual(2); // truncated + modal

    // Close button should be present
    expect(screen.getByText('Close')).toBeInTheDocument();
  });

  it('closes modal when Close button is clicked', async () => {
    const user = userEvent.setup();
    renderWithTruncation('Summary text for close test');

    await user.click(screen.getByText('Read more'));
    expect(screen.getByText('Task Summary')).toBeInTheDocument();

    await user.click(screen.getByText('Close'));
    expect(screen.queryByText('Task Summary')).not.toBeInTheDocument();
  });

  it('opens modal with scrollable overflow for long content', async () => {
    const user = userEvent.setup();
    renderWithTruncation('A very long summary that would overflow on mobile');

    await user.click(screen.getByText('Read more'));

    // The dialog panel should have overflow-y-auto and max-height constraint
    const dialogPanel = screen.getByRole('dialog').querySelector('[tabindex="-1"]');
    expect(dialogPanel).toBeInTheDocument();
    expect(dialogPanel?.className).toContain('overflow-y-auto');
    expect(dialogPanel?.className).toMatch(/max-h-/);
  });

  it('closes modal on Escape key', async () => {
    const user = userEvent.setup();
    renderWithTruncation('Summary text for escape test');

    await user.click(screen.getByText('Read more'));
    expect(screen.getByText('Task Summary')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByText('Task Summary')).not.toBeInTheDocument();
  });
});
