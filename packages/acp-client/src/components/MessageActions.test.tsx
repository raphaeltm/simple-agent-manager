import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MessageActions } from './MessageActions';

// Mock speechSynthesis API
const mockSpeak = vi.fn();
const mockCancel = vi.fn();
const mockAddEventListener = vi.fn();
const mockRemoveEventListener = vi.fn();

let capturedUtterance: { text: string; onend?: () => void; onerror?: () => void } | null = null;

function installSpeechMocks() {
  capturedUtterance = null;
  mockSpeak.mockImplementation((utterance: { text: string; onend?: () => void; onerror?: () => void }) => {
    capturedUtterance = utterance;
  });
  mockCancel.mockReset();
  mockAddEventListener.mockReset();
  mockRemoveEventListener.mockReset();

  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      speak: mockSpeak,
      cancel: mockCancel,
      addEventListener: mockAddEventListener,
      removeEventListener: mockRemoveEventListener,
    },
    writable: true,
    configurable: true,
  });

  vi.stubGlobal('SpeechSynthesisUtterance', class {
    text: string;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  });
}

beforeEach(() => {
  installSpeechMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Helper: find the text content next to a label like "Words:" inside the dialog. */
function getMetadataValue(dialog: HTMLElement, label: string): string {
  const labelEl = within(dialog).getByText(new RegExp(`${label}:`));
  // The value is the text node sibling inside the same parent div
  return labelEl.parentElement?.textContent?.replace(`${label}:`, '').trim() ?? '';
}

describe('MessageActions', () => {
  const defaultProps = {
    text: 'Hello, this is a test message with some words.',
    timestamp: 1710288000000, // 2024-03-13T00:00:00.000Z
  };

  describe('rendering', () => {
    it('renders info and speaker buttons', () => {
      render(<MessageActions {...defaultProps} />);

      expect(screen.getByLabelText('Message info')).toBeTruthy();
      expect(screen.getByLabelText('Read aloud')).toBeTruthy();
    });

    it('does not render speaker button when speechSynthesis is absent', () => {
      // Remove speechSynthesis from window
      Object.defineProperty(window, 'speechSynthesis', {
        value: undefined,
        writable: true,
        configurable: true,
      });

      render(<MessageActions {...defaultProps} />);

      expect(screen.getByLabelText('Message info')).toBeTruthy();
      expect(screen.queryByLabelText('Read aloud')).toBeNull();
    });
  });

  describe('metadata popover', () => {
    it('shows metadata when info button is clicked', () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      expect(screen.getByRole('tooltip')).toBeTruthy();
      expect(screen.getByText(/Time:/)).toBeTruthy();
      expect(screen.getByText(/Words:/)).toBeTruthy();
      expect(screen.getByText(/Characters:/)).toBeTruthy();
    });

    it('displays correct word count', () => {
      render(<MessageActions text="one two three four five" timestamp={defaultProps.timestamp} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      const dialog = screen.getByRole('tooltip');
      expect(getMetadataValue(dialog, 'Words')).toBe('5');
    });

    it('displays correct character count', () => {
      render(<MessageActions text="hello" timestamp={defaultProps.timestamp} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      const dialog = screen.getByRole('tooltip');
      expect(getMetadataValue(dialog, 'Characters')).toBe('5');
      expect(getMetadataValue(dialog, 'Words')).toBe('1');
    });

    it('handles empty text gracefully', () => {
      render(<MessageActions text="" timestamp={defaultProps.timestamp} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      const dialog = screen.getByRole('tooltip');
      expect(getMetadataValue(dialog, 'Words')).toBe('0');
      expect(getMetadataValue(dialog, 'Characters')).toBe('0');
    });

    it('strips inline code from word/char counts', () => {
      render(<MessageActions text="Use the `console.log` function" timestamp={defaultProps.timestamp} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      const dialog = screen.getByRole('tooltip');
      // "Use the  function" stripped → "Use the function" = 3 words
      expect(getMetadataValue(dialog, 'Words')).toBe('3');
    });

    it('strips fenced code blocks from word/char counts', () => {
      // After stripping ```...```, remaining text is "start end" = 2 words
      render(<MessageActions text={'start\n```js\nconst x = 1;\n```\nend'} timestamp={defaultProps.timestamp} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      const dialog = screen.getByRole('tooltip');
      expect(getMetadataValue(dialog, 'Words')).toBe('2');
    });

    it('displays formatted timestamp', () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      const dialog = screen.getByRole('tooltip');
      const timeValue = getMetadataValue(dialog, 'Time');
      // Should contain year 2024 from the timestamp
      expect(timeValue).toContain('2024');
    });

    it('hides metadata popover when clicked again (toggle)', () => {
      render(<MessageActions {...defaultProps} />);

      const btn = screen.getByLabelText('Message info');
      fireEvent.click(btn);
      expect(screen.getByRole('tooltip')).toBeTruthy();

      fireEvent.click(btn);
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('closes metadata popover on Escape key', () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Message info'));
      expect(screen.getByRole('tooltip')).toBeTruthy();

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('closes metadata popover on outside click', () => {
      render(
        <div>
          <button data-testid="outside">Outside</button>
          <MessageActions {...defaultProps} />
        </div>
      );

      fireEvent.click(screen.getByLabelText('Message info'));
      expect(screen.getByRole('tooltip')).toBeTruthy();

      // Click outside the component
      fireEvent.mouseDown(screen.getByTestId('outside'));
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('sets aria-expanded on info button', () => {
      render(<MessageActions {...defaultProps} />);
      const btn = screen.getByLabelText('Message info');

      expect(btn.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(btn);
      expect(btn.getAttribute('aria-expanded')).toBe('true');
    });
  });

  describe('text-to-speech', () => {
    it('calls speechSynthesis.speak when speaker button is clicked', () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));

      expect(mockCancel).toHaveBeenCalled();
      expect(mockSpeak).toHaveBeenCalledTimes(1);
    });

    it('changes button label to "Stop reading" while speaking', () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));

      expect(screen.getByLabelText('Stop reading')).toBeTruthy();
    });

    it('cancels speech when stop button is clicked', () => {
      render(<MessageActions {...defaultProps} />);

      // Start speaking
      fireEvent.click(screen.getByLabelText('Read aloud'));
      mockCancel.mockReset();

      // Stop speaking
      fireEvent.click(screen.getByLabelText('Stop reading'));

      expect(mockCancel).toHaveBeenCalled();
    });

    it('resets button state when speech ends naturally', () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));
      expect(screen.getByLabelText('Stop reading')).toBeTruthy();

      // Simulate speech ending — must be wrapped in act() to flush state update
      act(() => {
        capturedUtterance?.onend?.();
      });

      expect(screen.getByLabelText('Read aloud')).toBeTruthy();
    });

    it('resets button state on speech error', () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));

      act(() => {
        capturedUtterance?.onerror?.();
      });

      expect(screen.getByLabelText('Read aloud')).toBeTruthy();
    });

    it('cancels speech on unmount while speaking', () => {
      const { unmount } = render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));
      mockCancel.mockReset();

      unmount();

      expect(mockCancel).toHaveBeenCalled();
    });
  });
});
