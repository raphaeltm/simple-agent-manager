import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { VoiceButton } from './VoiceButton';

// Mock MediaRecorder
class MockMediaRecorder {
  state: string = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  mimeType: string = 'audio/webm;codecs=opus';

  static isTypeSupported = vi.fn().mockReturnValue(true);

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
    (globalThis as any).MediaRecorder = MockMediaRecorder;

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
    (globalThis as any).MediaRecorder = originalMediaRecorder;
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
      json: async () => ({ error: 'INTERNAL_ERROR', message: 'Server error' }),
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
