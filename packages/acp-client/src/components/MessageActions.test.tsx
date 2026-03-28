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

      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.getByText(/Time:/)).toBeTruthy();
      expect(screen.getByText(/Words:/)).toBeTruthy();
      expect(screen.getByText(/Characters:/)).toBeTruthy();
    });

    it('displays correct word count', () => {
      render(<MessageActions text="one two three four five" timestamp={defaultProps.timestamp} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      const dialog = screen.getByRole('dialog');
      expect(getMetadataValue(dialog, 'Words')).toBe('5');
    });

    it('displays correct character count', () => {
      render(<MessageActions text="hello" timestamp={defaultProps.timestamp} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      const dialog = screen.getByRole('dialog');
      expect(getMetadataValue(dialog, 'Characters')).toBe('5');
      expect(getMetadataValue(dialog, 'Words')).toBe('1');
    });

    it('handles empty text gracefully', () => {
      render(<MessageActions text="" timestamp={defaultProps.timestamp} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      const dialog = screen.getByRole('dialog');
      expect(getMetadataValue(dialog, 'Words')).toBe('0');
      expect(getMetadataValue(dialog, 'Characters')).toBe('0');
    });

    it('strips inline code from word/char counts', () => {
      render(<MessageActions text="Use the `console.log` function" timestamp={defaultProps.timestamp} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      const dialog = screen.getByRole('dialog');
      // "Use the  function" stripped → "Use the function" = 3 words
      expect(getMetadataValue(dialog, 'Words')).toBe('3');
    });

    it('strips fenced code blocks from word/char counts', () => {
      // After stripping ```...```, remaining text is "start end" = 2 words
      render(<MessageActions text={'start\n```js\nconst x = 1;\n```\nend'} timestamp={defaultProps.timestamp} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      const dialog = screen.getByRole('dialog');
      expect(getMetadataValue(dialog, 'Words')).toBe('2');
    });

    it('displays formatted timestamp', () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Message info'));

      const dialog = screen.getByRole('dialog');
      const timeValue = getMetadataValue(dialog, 'Time');
      // Should contain year 2024 from the timestamp
      expect(timeValue).toContain('2024');
    });

    it('hides metadata popover when clicked again (toggle)', () => {
      render(<MessageActions {...defaultProps} />);

      const btn = screen.getByLabelText('Message info');
      fireEvent.click(btn);
      expect(screen.getByRole('dialog')).toBeTruthy();

      fireEvent.click(btn);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('closes metadata popover on Escape key', () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Message info'));
      expect(screen.getByRole('dialog')).toBeTruthy();

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('closes metadata popover on outside click', () => {
      render(
        <div>
          <button data-testid="outside">Outside</button>
          <MessageActions {...defaultProps} />
        </div>
      );

      fireEvent.click(screen.getByLabelText('Message info'));
      expect(screen.getByRole('dialog')).toBeTruthy();

      // Click outside the component
      fireEvent.mouseDown(screen.getByTestId('outside'));
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

  describe('text-to-speech (browser fallback)', () => {
    it('calls speechSynthesis.speak when speaker button is clicked', () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));

      expect(mockCancel).toHaveBeenCalled();
      expect(mockSpeak).toHaveBeenCalledTimes(1);
    });

    it('changes button to pause when playing', () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));

      // Both the speaker button and the AudioPlayer have a Pause button
      expect(screen.getAllByLabelText('Pause').length).toBeGreaterThanOrEqual(1);
    });

    it('cancels speech when stop is clicked via player close', () => {
      render(<MessageActions {...defaultProps} />);

      // Start speaking
      fireEvent.click(screen.getByLabelText('Read aloud'));
      mockCancel.mockReset();

      // The audio player should appear — click the close button
      const closeBtn = screen.getByLabelText('Close player');
      fireEvent.click(closeBtn);

      expect(mockCancel).toHaveBeenCalled();
    });

    it('resets button state when speech ends naturally', () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));
      expect(screen.getAllByLabelText('Pause').length).toBeGreaterThanOrEqual(1);

      // Simulate speech ending
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
        onloadedmetadata: (() => void) | null = null;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        playbackRate = 1;
        currentTime = 0;
        duration = 60;
        play = mockPlay;
        pause = vi.fn();
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
        onloadedmetadata: (() => void) | null = null;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        playbackRate = 1;
        currentTime = 0;
        duration = 60;
        play = vi.fn().mockResolvedValue(undefined);
        pause = vi.fn();
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
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Make the fetch hang until we resolve it
      let resolveFetch: (value: unknown) => void;
      const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingFetch));

      render(<MessageActions {...ttsProps} />);

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Read aloud'));
      });

      // Should show loading labels (both speaker button and AudioPlayer have cancel)
      expect(screen.getAllByLabelText('Cancel audio generation').length).toBeGreaterThanOrEqual(1);

      // Clean up: resolve the pending fetch and wait for state updates to settle
      await act(async () => {
        resolveFetch!({
          ok: false,
          json: () => Promise.resolve({ message: 'cancelled' }),
        });
      });

      consoleSpy.mockRestore();
    });

    it('falls back to browser TTS on synthesis API failure', async () => {
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

      // Should fall back to browser TTS (speechSynthesis.speak is called)
      expect(mockSpeak).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('shows audio player UI when playing', async () => {
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
        onloadedmetadata: (() => void) | null = null;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        playbackRate = 1;
        currentTime = 0;
        duration = 60;
        play = vi.fn().mockResolvedValue(undefined);
        pause = vi.fn();
      });

      render(<MessageActions {...ttsProps} />);

      // No player visible initially
      expect(screen.queryByRole('region', { name: 'Audio player' })).toBeNull();

      fireEvent.click(screen.getByLabelText('Read aloud'));

      // Wait for async chain
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      // Player should be visible
      await waitFor(() => {
        expect(screen.getByRole('region', { name: 'Audio player' })).toBeTruthy();
      });
    });

    it('prevents double playback on rapid clicks (re-entrance guard)', async () => {
      const mockFetch = vi.fn();
      // Both calls resolve successfully
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ audioUrl: '/api/tts/audio/msg-123' }),
        blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/mpeg' })),
      });
      vi.stubGlobal('fetch', mockFetch);
      vi.stubGlobal('Audio', class {
        src = '';
        onloadedmetadata: (() => void) | null = null;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        playbackRate = 1;
        currentTime = 0;
        duration = 60;
        play = vi.fn().mockResolvedValue(undefined);
        pause = vi.fn();
      });

      render(<MessageActions {...ttsProps} />);
      const btn = screen.getByLabelText('Read aloud');

      // Click twice rapidly (synchronous — both before React re-renders)
      fireEvent.click(btn);
      fireEvent.click(btn);

      // Wait for any async processing
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });

      // Exactly 2 fetches from the first click (synthesize + audio fetch).
      // The second click must be blocked by the re-entrance guard — not 0 (both blocked), not 4 (both went through).
      expect(mockFetch.mock.calls.length).toBe(2);
    });

    it('reuses cached blob URL on replay (no extra API calls)', async () => {
      const mockPlay = vi.fn().mockResolvedValue(undefined);
      const mockPause = vi.fn();
      const mockFetch = vi.fn();

      // Set up URL mocks explicitly for this test
      URL.createObjectURL = vi.fn().mockReturnValue('blob:test-cached-url');
      URL.revokeObjectURL = vi.fn();

      // First play: two fetches (synthesize + audio)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ audioUrl: '/api/tts/audio/msg-123' }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/mpeg' })),
      });
      vi.stubGlobal('fetch', mockFetch);

      let latestAudio: { onended?: (() => void) | null };
      vi.stubGlobal('Audio', class {
        src = '';
        onloadedmetadata: (() => void) | null = null;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        playbackRate = 1;
        currentTime = 0;
        duration = 60;
        play = mockPlay;
        pause = mockPause;
        constructor() {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          latestAudio = this;
        }
      });

      render(<MessageActions {...ttsProps} />);

      // First play — triggers fetch
      fireEvent.click(screen.getByLabelText('Read aloud'));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(mockPlay).toHaveBeenCalledTimes(1));

      // Simulate audio ending naturally
      await act(async () => {
        latestAudio!.onended?.();
      });

      // Should return to idle state
      await waitFor(() => {
        expect(screen.getByLabelText('Read aloud')).toBeTruthy();
      });

      // Clear mocks to track second play
      mockFetch.mockClear();
      mockPlay.mockClear();

      // Second play — should reuse cached blob URL, no new fetch
      fireEvent.click(screen.getByLabelText('Read aloud'));
      await waitFor(() => expect(mockPlay).toHaveBeenCalledTimes(1));

      // No new API calls — blob URL was reused from cache
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('aborts in-flight requests when stopping during loading', async () => {
      const abortSpy = vi.fn();
      const originalAbortController = globalThis.AbortController;
      let capturedSignal: unknown = null;

      vi.stubGlobal('AbortController', class {
        signal = { aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
        abort = () => {
          abortSpy();
          (this.signal as { aborted: boolean }).aborted = true;
        };
      });

      // Make fetch hang, but capture the signal argument
      const mockFetch = vi.fn().mockImplementation((_url: string, opts?: { signal?: unknown }) => {
        if (opts?.signal) capturedSignal = opts.signal;
        return new Promise(() => {});
      });
      vi.stubGlobal('fetch', mockFetch);

      render(<MessageActions {...ttsProps} />);

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Read aloud'));
      });

      // Verify fetch was called with an abort signal
      expect(capturedSignal).not.toBeNull();

      // Should be in loading state (both speaker button and player show cancel)
      const cancelBtns = screen.getAllByLabelText('Cancel audio generation');
      expect(cancelBtns.length).toBeGreaterThanOrEqual(1);

      // Stop/cancel — click the first cancel button (speaker button)
      const cancelBtn = cancelBtns[0]!;
      await act(async () => {
        fireEvent.click(cancelBtn);
      });

      // AbortController.abort() should have been called
      expect(abortSpy).toHaveBeenCalled();

      // Restore
      vi.stubGlobal('AbortController', originalAbortController);
    });

    it('cleans up blob URL and resets state on audio error', async () => {
      const mockPlay = vi.fn().mockResolvedValue(undefined);
      const mockRevokeObjectURL = vi.fn();

      URL.createObjectURL = vi.fn().mockReturnValue('blob:error-test-url');
      URL.revokeObjectURL = mockRevokeObjectURL;

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

      let latestAudio: { onerror?: (() => void) | null };
      vi.stubGlobal('Audio', class {
        src = '';
        onloadedmetadata: (() => void) | null = null;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        playbackRate = 1;
        currentTime = 0;
        duration = 60;
        play = mockPlay;
        pause = vi.fn();
        constructor() {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          latestAudio = this;
        }
      });

      render(<MessageActions {...ttsProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));
      await waitFor(() => expect(mockPlay).toHaveBeenCalledTimes(1));

      // Trigger audio error
      await act(async () => {
        latestAudio!.onerror?.();
      });

      // Should return to idle state
      await waitFor(() => {
        expect(screen.getByLabelText('Read aloud')).toBeTruthy();
      });

      // Blob URL should have been revoked on error
      expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:error-test-url');
    });
  });

  describe('hideTts prop', () => {
    it('hides speaker button when hideTts is true', () => {
      render(<MessageActions {...defaultProps} hideTts />);

      expect(screen.getByLabelText('Message info')).toBeTruthy();
      expect(screen.getByLabelText('Copy message')).toBeTruthy();
      expect(screen.queryByLabelText('Read aloud')).toBeNull();
    });

    it('hides audio player when hideTts is true', () => {
      render(<MessageActions {...defaultProps} hideTts />);

      expect(screen.queryByRole('region', { name: 'Audio player' })).toBeNull();
    });
  });

  describe('variant prop (on-dark)', () => {
    it('uses white-ish colors for buttons on dark backgrounds', () => {
      render(<MessageActions {...defaultProps} variant="on-dark" hideTts />);

      const infoBtn = screen.getByLabelText('Message info');
      expect(infoBtn.style.color).toBe('rgba(255, 255, 255, 0.7)');
    });

    it('uses white for active info button on dark backgrounds', () => {
      render(<MessageActions {...defaultProps} variant="on-dark" hideTts />);

      fireEvent.click(screen.getByLabelText('Message info'));
      const infoBtn = screen.getByLabelText('Message info');
      expect(infoBtn.style.color).toBe('rgb(255, 255, 255)');
    });

    it('uses white for copied state on dark backgrounds', async () => {
      render(<MessageActions {...defaultProps} variant="on-dark" hideTts />);

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Copy message'));
      });

      const copyBtn = screen.getByLabelText('Copied');
      expect(copyBtn.style.color).toBe('rgb(255, 255, 255)');
    });
  });

  describe('accessibility — focus rings and touch targets', () => {
    it('info button has focus-visible outline class', () => {
      render(<MessageActions {...defaultProps} hideTts />);
      const btn = screen.getByLabelText('Message info');
      expect(btn.className).toContain('focus-visible:outline');
    });

    it('copy button has focus-visible outline class', () => {
      render(<MessageActions {...defaultProps} hideTts />);
      const btn = screen.getByLabelText('Copy message');
      expect(btn.className).toContain('focus-visible:outline');
    });

    it('speaker button has focus-visible outline class', () => {
      render(<MessageActions {...defaultProps} />);
      const btn = screen.getByLabelText('Read aloud');
      expect(btn.className).toContain('focus-visible:outline');
    });

    it('info button meets 44px minimum touch target', () => {
      render(<MessageActions {...defaultProps} hideTts />);
      const btn = screen.getByLabelText('Message info');
      expect(btn.className).toContain('min-w-[44px]');
      expect(btn.className).toContain('min-h-[44px]');
    });

    it('copy button meets 44px minimum touch target', () => {
      render(<MessageActions {...defaultProps} hideTts />);
      const btn = screen.getByLabelText('Copy message');
      expect(btn.className).toContain('min-w-[44px]');
      expect(btn.className).toContain('min-h-[44px]');
    });
  });

  describe('popover alignment by variant', () => {
    it('popover uses left-0 for default (agent) variant', () => {
      render(<MessageActions {...defaultProps} />);
      fireEvent.click(screen.getByLabelText('Message info'));
      const dialog = screen.getByRole('dialog');
      expect(dialog.className).toContain('left-0');
      expect(dialog.className).not.toContain('right-0');
    });

    it('popover uses right-0 for on-dark (user) variant', () => {
      render(<MessageActions {...defaultProps} variant="on-dark" hideTts />);
      fireEvent.click(screen.getByLabelText('Message info'));
      const dialog = screen.getByRole('dialog');
      expect(dialog.className).toContain('right-0');
      expect(dialog.className).not.toContain('left-0');
    });
  });

  describe('onPlayAudio prop — global player delegation', () => {
    it('calls onPlayAudio when speaker button is clicked', () => {
      const onPlayAudio = vi.fn();
      render(<MessageActions {...defaultProps} onPlayAudio={onPlayAudio} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));

      expect(onPlayAudio).toHaveBeenCalledOnce();
    });

    it('does not call local audio.toggle when onPlayAudio is provided', () => {
      // If the local hook's toggle were called, browser speechSynthesis.speak would be invoked.
      const onPlayAudio = vi.fn();
      render(<MessageActions {...defaultProps} onPlayAudio={onPlayAudio} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));

      // Browser TTS must NOT have been invoked — delegation went to onPlayAudio
      expect(mockSpeak).not.toHaveBeenCalled();
    });

    it('speaker button aria-label is always "Read aloud" when delegating', () => {
      // When using global player the label must not reflect local audio state
      const onPlayAudio = vi.fn();
      render(<MessageActions {...defaultProps} onPlayAudio={onPlayAudio} />);

      const btn = screen.getByLabelText('Read aloud');
      expect(btn).toBeTruthy();
    });

    it('does not render inline AudioPlayer when onPlayAudio is provided', () => {
      const onPlayAudio = vi.fn();
      render(<MessageActions {...defaultProps} onPlayAudio={onPlayAudio} />);

      // Inline AudioPlayer must not appear even after clicking
      fireEvent.click(screen.getByLabelText('Read aloud'));

      expect(screen.queryByRole('region', { name: 'Audio player' })).toBeNull();
    });

    it('speaker button is still shown when hideTts is false and onPlayAudio is provided', () => {
      const onPlayAudio = vi.fn();
      render(<MessageActions {...defaultProps} onPlayAudio={onPlayAudio} hideTts={false} />);

      expect(screen.getByLabelText('Read aloud')).toBeTruthy();
    });

    it('speaker button is hidden when hideTts is true even if onPlayAudio is provided', () => {
      const onPlayAudio = vi.fn();
      render(<MessageActions {...defaultProps} onPlayAudio={onPlayAudio} hideTts />);

      expect(screen.queryByLabelText('Read aloud')).toBeNull();
    });

    it('screen-reader aria-live span is not rendered when delegating', () => {
      const onPlayAudio = vi.fn();
      const { container } = render(<MessageActions {...defaultProps} onPlayAudio={onPlayAudio} />);

      // The sr-only aria-live span that announces local state is suppressed
      const srSpans = container.querySelectorAll('.sr-only[aria-live]');
      expect(srSpans.length).toBe(0);
    });

    it('onPlayAudio is invoked once when speaker button is clicked', () => {
      const onPlayAudio = vi.fn();
      render(<MessageActions {...defaultProps} onPlayAudio={onPlayAudio} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));

      expect(onPlayAudio).toHaveBeenCalledTimes(1);
    });
  });

  describe('audio player controls', () => {
    it('has speed selector with correct options', async () => {
      // Use browser TTS to get player to show
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));

      // Player should appear
      await waitFor(() => {
        expect(screen.getByRole('region', { name: 'Audio player' })).toBeTruthy();
      });

      const speedSelect = screen.getByLabelText('Playback speed');
      expect(speedSelect).toBeTruthy();

      // Check speed options exist
      const options = speedSelect.querySelectorAll('option');
      const values = Array.from(options).map((o) => o.value);
      expect(values).toEqual(['0.5', '0.75', '1', '1.25', '1.5', '2']);
    });

    it('has skip forward and skip back buttons', async () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));

      await waitFor(() => {
        expect(screen.getByLabelText('Skip back 10 seconds')).toBeTruthy();
        expect(screen.getByLabelText('Skip forward 10 seconds')).toBeTruthy();
      });
    });

    it('has close button that stops playback', async () => {
      render(<MessageActions {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Read aloud'));

      await waitFor(() => {
        expect(screen.getByRole('region', { name: 'Audio player' })).toBeTruthy();
      });

      fireEvent.click(screen.getByLabelText('Close player'));

      // Player should be gone
      expect(screen.queryByRole('region', { name: 'Audio player' })).toBeNull();
      // Button should be back to "Read aloud"
      expect(screen.getByLabelText('Read aloud')).toBeTruthy();
    });
  });
});
