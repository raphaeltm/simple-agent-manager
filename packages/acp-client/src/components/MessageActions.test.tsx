import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MessageActions } from './MessageActions';

// Mock speechSynthesis API
const mockSpeak = vi.fn();
const mockCancel = vi.fn();
const mockAddEventListener = vi.fn();
const mockRemoveEventListener = vi.fn();

let capturedUtterance: { text: string; onend?: () => void; onerror?: () => void } | null = null;

beforeEach(() => {
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

  // Mock SpeechSynthesisUtterance
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    text: string;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
  });

  describe('metadata popover', () => {
    it('shows metadata when info button is clicked', () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.getByText(/Time:/)).toBeTruthy();
      expect(screen.getByText(/Words:/)).toBeTruthy();
      expect(screen.getByText(/Characters:/)).toBeTruthy();
    });

    it('displays correct word count', () => {
      render(<MessageActions text="one two three four five" timestamp={defaultProps.timestamp} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      // "one two three four five" = 5 words
      expect(screen.getByText('5')).toBeTruthy();
    });

    it('displays correct character count', () => {
      render(<MessageActions text="hello" timestamp={defaultProps.timestamp} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      expect(screen.getByText('5')).toBeTruthy();
    });

    it('strips markdown from word/char counts', () => {
      // "Use the function" after stripping `console.log` inline code
      render(<MessageActions text="Use the `console.log` function" timestamp={defaultProps.timestamp} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      // "Use the  function" stripped → "Use the function" = 3 words
      expect(screen.getByText('3')).toBeTruthy();
    });

    it('hides metadata popover when clicked again (toggle)', () => {
      render(<MessageActions {...defaultProps} />);

      const btn = screen.getByLabelText('Message info');
      fireEvent.click(btn);
      expect(screen.getByRole('dialog')).toBeTruthy();

      fireEvent.click(btn);
      expect(screen.queryByRole('dialog')).toBeNull();
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
  });
});

describe('MessageActions in MessageBubble', () => {
  // Integration-style tests to verify MessageActions appears correctly in MessageBubble
  it('is covered by MessageBubble integration — see MessageBubble.test.tsx', () => {
    // This is a marker test — the actual integration tests are in MessageBubble.test.tsx
    expect(true).toBe(true);
  });
});
