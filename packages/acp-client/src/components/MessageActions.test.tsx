import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react';
import { MessageActions } from './MessageActions';

// Mock clipboard API
const mockWriteText = vi.fn<(text: string) => Promise<void>>();

function installClipboardMock() {
  mockWriteText.mockReset();
  mockWriteText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: mockWriteText },
    writable: true,
    configurable: true,
  });
}

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
  installClipboardMock();
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
    it('renders info, speaker, and copy buttons', () => {
      render(<MessageActions {...defaultProps} />);

      expect(screen.getByLabelText('Message info')).toBeTruthy();
      expect(screen.getByLabelText('Read aloud')).toBeTruthy();
      expect(screen.getByLabelText('Copy message')).toBeTruthy();
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

  describe('copy to clipboard', () => {
    it('copies message text when copy button is clicked', async () => {
      render(<MessageActions {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Copy message'));
      });

      expect(mockWriteText).toHaveBeenCalledWith(defaultProps.text);
    });

    it('shows "Copied" label after successful copy', async () => {
      render(<MessageActions {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Copy message'));
      });

      expect(screen.getByLabelText('Copied')).toBeTruthy();
    });

    it('resets to "Copy message" label after timeout', async () => {
      vi.useFakeTimers();

      render(<MessageActions {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Copy message'));
      });

      expect(screen.getByLabelText('Copied')).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(1500);
      });

      expect(screen.getByLabelText('Copy message')).toBeTruthy();

      vi.useRealTimers();
    });

    it('does not render copy button when clipboard API is absent', () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        writable: true,
        configurable: true,
      });

      render(<MessageActions {...defaultProps} />);

      expect(screen.queryByLabelText('Copy message')).toBeNull();
    });

    it('does not show "Copied" when clipboard write fails', async () => {
      mockWriteText.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));

      render(<MessageActions {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Copy message'));
      });

      // Should remain as "Copy message", not switch to "Copied"
      expect(screen.getByLabelText('Copy message')).toBeTruthy();
      expect(screen.queryByLabelText('Copied')).toBeNull();
    });

    it('copies the raw text including markdown', async () => {
      const mdText = '# Hello\n\nThis is **bold** and `code`.';
      render(<MessageActions text={mdText} timestamp={defaultProps.timestamp} />);

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Copy message'));
      });

      expect(mockWriteText).toHaveBeenCalledWith(mdText);
    });
  });

  describe('server-side TTS', () => {
    const ttsProps = {
      ...defaultProps,
      ttsApiUrl: 'https://api.example.com/api/tts',
      ttsStorageId: 'msg-123',
    };

    // jsdom doesn't provide URL.createObjectURL/revokeObjectURL
    beforeEach(() => {
      if (!URL.createObjectURL) {
        URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
      }
      if (!URL.revokeObjectURL) {
        URL.revokeObjectURL = vi.fn();
      }
    });

    it('shows speaker button when ttsApiUrl is provided (even without speechSynthesis)', () => {
      // Remove browser speechSynthesis
      Object.defineProperty(window, 'speechSynthesis', {
        value: undefined,
        writable: true,
        configurable: true,
      });

      render(<MessageActions {...ttsProps} />);
      expect(screen.getByLabelText('Read aloud')).toBeTruthy();
    });

    it('calls server TTS API when ttsApiUrl is provided', async () => {
      const mockFetch = vi.fn();
      // First call: POST /synthesize
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ audioUrl: '/api/tts/audio/msg-123' }),
      });
      // Second call: GET /audio
      mockFetch.mockResolvedValueOnce({
        ok: true,
        blob: () => Promise.resolve(new Blob(['fake-audio'], { type: 'audio/mpeg' })),
      });
      vi.stubGlobal('fetch', mockFetch);

      // Mock Audio constructor
      const mockPlay = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('Audio', class {
        src = '';
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        play = mockPlay;
        pause = vi.fn();
        currentTime = 0;
      });

      render(<MessageActions {...ttsProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));

      // Wait for the full async chain (synthesize → fetch audio → play) to complete
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      // Verify synthesis API was called with correct params
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/api/tts/synthesize',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          body: JSON.stringify({ text: ttsProps.text, storageId: 'msg-123' }),
        }),
      );

      // Verify audio was fetched
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/api/tts/audio/msg-123',
        expect.objectContaining({ credentials: 'include' }),
      );

      // Verify audio playback started
      await waitFor(() => {
        expect(mockPlay).toHaveBeenCalled();
      });
    });

    it('does not use browser speechSynthesis when ttsApiUrl is provided', async () => {
      const mockFetch = vi.fn();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ audioUrl: '/api/tts/audio/msg-123' }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/mpeg' })),
      });
      vi.stubGlobal('fetch', mockFetch);
      vi.stubGlobal('Audio', class {
        src = '';
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        play = vi.fn().mockResolvedValue(undefined);
        pause = vi.fn();
        currentTime = 0;
      });
      render(<MessageActions {...ttsProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));

      // Wait for async TTS chain to complete
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      // Browser speechSynthesis should NOT have been called
      expect(mockSpeak).not.toHaveBeenCalled();
    });

    it('shows loading state while generating audio', async () => {
      // Make the fetch hang
      let resolveFetch: (value: unknown) => void;
      const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingFetch));

      render(<MessageActions {...ttsProps} />);

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Read aloud'));
      });

      // Should show loading label
      expect(screen.getByLabelText('Generating audio...')).toBeTruthy();

      // Clean up
      resolveFetch!({
        ok: false,
        json: () => Promise.resolve({ message: 'cancelled' }),
      });
    });

    it('handles synthesis API failure gracefully', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ message: 'Server error' }),
      }));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(<MessageActions {...ttsProps} />);

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Read aloud'));
      });

      // Should revert to Read aloud state (not stuck in loading)
      expect(screen.getByLabelText('Read aloud')).toBeTruthy();

      consoleSpy.mockRestore();
    });
  });
});
