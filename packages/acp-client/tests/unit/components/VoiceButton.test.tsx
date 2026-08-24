import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { VoiceButton } from '../../../src/components/VoiceButton';

// Mock MediaRecorder
class MockMediaRecorder {
  state: string = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  mimeType: string = 'audio/webm;codecs=opus';

  static isTypeSupported = vi.fn().mockReturnValue(true);
  /** Lets a test reach the recorder the component created, to fire deferred events. */
  static lastInstance: MockMediaRecorder | null = null;

  constructor() {
    MockMediaRecorder.lastInstance = this;
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    // Simulate data available
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob(['fake-audio'], { type: 'audio/webm' }) });
    }
    // Simulate stop
    if (this.onstop) {
      this.onstop();
    }
  }
}

// Mock stream with stop-capable tracks
function createMockStream(): MediaStream {
  const track = {
    stop: vi.fn(),
    kind: 'audio',
    enabled: true,
  } as unknown as MediaStreamTrack;

  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
  } as unknown as MediaStream;
}

describe('VoiceButton', () => {
  const mockOnTranscription = vi.fn();
  let originalMediaDevices: typeof navigator.mediaDevices;
  let originalMediaRecorder: typeof globalThis.MediaRecorder;

  beforeEach(() => {
    vi.clearAllMocks();
    originalMediaDevices = navigator.mediaDevices;
    originalMediaRecorder = globalThis.MediaRecorder;

    // Setup MediaRecorder mock
    Object.defineProperty(globalThis, 'MediaRecorder', {
      value: MockMediaRecorder,
      writable: true,
      configurable: true,
    });

    // Setup getUserMedia mock
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(createMockStream()),
      },
      writable: true,
      configurable: true,
    });

    // Mock fetch for transcription API calls
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Transcribed text' }),
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'MediaRecorder', {
      value: originalMediaRecorder,
      writable: true,
      configurable: true,
    });
  });

  it('renders with microphone icon in idle state', () => {
    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
      />
    );

    const button = screen.getByRole('button', { name: /start voice input/i });
    expect(button).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('is disabled when disabled prop is true', () => {
    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
        disabled={true}
      />
    );

    const button = screen.getByRole('button');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('has minimum 44px touch target', () => {
    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
      />
    );

    const button = screen.getByRole('button');
    expect(button.style.minWidth).toBe('44px');
    expect(button.style.minHeight).toBe('44px');
  });

  it('starts recording on click', async () => {
    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
      />
    );

    const button = screen.getByRole('button', { name: /start voice input/i });
    await act(async () => {
      fireEvent.click(button);
    });

    // Should now show stop button
    await waitFor(() => {
      const stopButton = screen.getByRole('button', { name: /stop recording/i });
      expect(stopButton).toBeTruthy();
    });
  });

  it('requests microphone permission on click', async () => {
    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
      />
    );

    const button = screen.getByRole('button');
    await act(async () => {
      fireEvent.click(button);
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it('handles microphone permission denied', async () => {
    const error = new DOMException('Permission denied', 'NotAllowedError');
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
      />
    );

    const button = screen.getByRole('button');
    await act(async () => {
      fireEvent.click(button);
    });

    // Should show error state
    await waitFor(() => {
      const errorButton = screen.getByTitle(/microphone permission denied/i);
      expect(errorButton).toBeTruthy();
    });
  });

  it('handles no microphone found', async () => {
    const error = new DOMException('No device', 'NotFoundError');
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
      />
    );

    const button = screen.getByRole('button');
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => {
      const errorButton = screen.getByTitle(/no microphone found/i);
      expect(errorButton).toBeTruthy();
    });
  });

  it('sends audio to API and calls onTranscription on success', async () => {
    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
      />
    );

    // Start recording
    const button = screen.getByRole('button');
    await act(async () => {
      fireEvent.click(button);
    });

    // Stop recording (triggers transcription)
    await act(async () => {
      const stopButton = screen.getByRole('button', { name: /stop recording/i });
      fireEvent.click(stopButton);
    });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/api/transcribe',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
        })
      );
    });

    await waitFor(() => {
      expect(mockOnTranscription).toHaveBeenCalledWith('Transcribed text');
    });
  });

  it('handles transcription API failure', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Server error' }),
    });

    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
      />
    );

    // Start recording
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    // Stop recording
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    });

    // Should show error but NOT call onTranscription
    await waitFor(() => {
      expect(mockOnTranscription).not.toHaveBeenCalled();
    });
  });

  it('uses rounded-full for circular button shape', () => {
    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
      />
    );

    const button = screen.getByRole('button');
    expect(button.className).toContain('rounded-full');
  });

  it('shows amplitude glow when recording', async () => {
    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
      />
    );

    const button = screen.getByRole('button');
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => {
      const recordingButton = screen.getByRole('button', { name: /stop recording/i });
      // Should have a box-shadow style for glow effect
      expect(recordingButton.style.boxShadow).toContain('rgba(239, 68, 68');
    });
  });

  it('calls onError callback on transcription API failure', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Server error' }),
    });

    const mockOnError = vi.fn();

    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
        onError={mockOnError}
      />
    );

    // Start recording
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    // Stop recording (triggers transcription)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    });

    await waitFor(() => {
      expect(mockOnError).toHaveBeenCalledTimes(1);
      expect(mockOnError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.any(String),
          source: 'VoiceButton',
          context: expect.objectContaining({ phase: 'transcription' }),
        })
      );
    });
  });

  it('calls onError callback on microphone permission denied', async () => {
    const error = new DOMException('Permission denied', 'NotAllowedError');
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const mockOnError = vi.fn();

    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
        onError={mockOnError}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    await waitFor(() => {
      expect(mockOnError).toHaveBeenCalledTimes(1);
      expect(mockOnError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Microphone permission denied',
          source: 'VoiceButton',
          context: expect.objectContaining({ phase: 'mic-access' }),
        })
      );
    });
  });

  it('reports each state transition through onStateChange as the user records', async () => {
    const onStateChange = vi.fn();

    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
        onStateChange={onStateChange}
      />
    );

    // Mounting publishes the initial state so a host can render from it directly.
    expect(onStateChange.mock.calls.map(([state]) => state)).toEqual(['idle']);

    const button = screen.getByRole('button');
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => {
      expect(onStateChange).toHaveBeenCalledWith('recording');
    });

    // Stopping runs the transcription round-trip and returns to idle.
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    await waitFor(() => {
      expect(mockOnTranscription).toHaveBeenCalledWith('Transcribed text');
    });

    expect(onStateChange.mock.calls.map(([state]) => state)).toEqual([
      'idle',
      'recording',
      'processing',
      'idle',
    ]);
  });

  it('does not upload audio when the host unmounted mid-recording', async () => {
    const { unmount } = render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    // Unmount while still recording — e.g. the host composer was cancelled.
    // Real MediaRecorders still fire onstop once their tracks end, so the
    // deferred handler must not upload to a callback that no longer exists.
    const live = MockMediaRecorder.lastInstance;
    expect(live).toBeTruthy();
    unmount();
    await act(async () => {
      live!.stop();
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockOnTranscription).not.toHaveBeenCalled();
  });

  it('does not re-notify onStateChange when only the callback identity changes', async () => {
    const onStateChange = vi.fn();
    const { rerender } = render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
        onStateChange={onStateChange}
      />
    );

    expect(onStateChange).toHaveBeenCalledTimes(1);

    // A host passing an inline arrow function re-renders with a new identity on
    // every parent render; that must not look like a state transition.
    rerender(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
        onStateChange={(state) => onStateChange(state)}
      />
    );

    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  it('handles browser without mediaDevices support', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    render(
      <VoiceButton
        onTranscription={mockOnTranscription}
        apiUrl="https://api.example.com/api/transcribe"
      />
    );

    const button = screen.getByRole('button');
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => {
      const errorButton = screen.getByTitle(/microphone not supported/i);
      expect(errorButton).toBeTruthy();
    });
  });
});
