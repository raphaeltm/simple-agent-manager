import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAudioPlayback } from '../../../src/hooks/useAudioPlayback';

class MockAudio {
  static instances: MockAudio[] = [];

  currentTime = 0;
  duration = 42;
  playbackRate = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(() => Promise.resolve());
  src: string;

  constructor(src: string) {
    this.src = src;
    MockAudio.instances.push(this);
  }
}

class MockSpeechSynthesisUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  text: string;

  constructor(text: string) {
    this.text = text;
  }
}

const fetchMock = vi.fn<typeof fetch>();
const createObjectURLMock = vi.fn(() => 'blob:tts-audio');
const revokeObjectURLMock = vi.fn();
const speechSynthesisMock = {
  cancel: vi.fn(),
  speak: vi.fn(),
};

function synthesizeResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function audioResponse(status = 200): Response {
  return new Response(new TextEncoder().encode('audio-bytes'), {
    status,
    headers: { 'Content-Type': 'audio/mpeg' },
  });
}

function mockServerTtsSuccess() {
  fetchMock
    .mockResolvedValueOnce(synthesizeResponse({ audioUrl: '/api/tts/audio/abc', summarized: true }))
    .mockResolvedValueOnce(audioResponse());
}

describe('useAudioPlayback', () => {
  beforeEach(() => {
    MockAudio.instances = [];
    fetchMock.mockReset();
    createObjectURLMock.mockClear();
    revokeObjectURLMock.mockClear();
    speechSynthesisMock.cancel.mockClear();
    speechSynthesisMock.speak.mockClear();

    globalThis.fetch = fetchMock;
    globalThis.Audio = MockAudio as unknown as typeof Audio;
    globalThis.SpeechSynthesisUtterance =
      MockSpeechSynthesisUtterance as unknown as typeof SpeechSynthesisUtterance;
    URL.createObjectURL = createObjectURLMock;
    URL.revokeObjectURL = revokeObjectURLMock;
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: speechSynthesisMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('plays server TTS, tracks metadata, and caches the generated blob URL', async () => {
    mockServerTtsSuccess();
    const { result } = renderHook(() =>
      useAudioPlayback({
        text: 'Hello **world**',
        ttsApiUrl: 'https://api.example.com/api/tts',
        ttsStorageId: 'msg-1',
      })
    );

    await act(async () => {
      result.current.play();
    });

    await waitFor(() => expect(result.current.state).toBe('playing'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.example.com/api/tts/synthesize', expect.objectContaining({
      body: JSON.stringify({ text: 'Hello **world**', storageId: 'msg-1' }),
      credentials: 'include',
      method: 'POST',
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://api.example.com/api/tts/audio/abc', expect.objectContaining({
      credentials: 'include',
    }));
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(result.current.summarized).toBe(true);

    act(() => {
      MockAudio.instances[0]?.onloadedmetadata?.();
    });
    expect(result.current.duration).toBe(42);

    act(() => {
      result.current.stop();
    });

    await act(async () => {
      result.current.play();
    });

    await waitFor(() => expect(result.current.state).toBe('playing'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(MockAudio.instances).toHaveLength(2);
  });

  it('falls back to browser speech synthesis when server TTS fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(synthesizeResponse({ message: 'quota exceeded' }, 429));
    const { result } = renderHook(() =>
      useAudioPlayback({
        text: 'Read `code` and **markdown**',
        ttsApiUrl: 'https://api.example.com/api/tts',
        ttsStorageId: 'msg-2',
      })
    );

    await act(async () => {
      result.current.play();
    });

    await waitFor(() => expect(result.current.state).toBe('playing'));
    expect(result.current.error).toBe('quota exceeded');
    expect(result.current.lastError).toBe('quota exceeded');
    expect(consoleError).toHaveBeenCalledWith('TTS playback error:', 'quota exceeded');
    expect(speechSynthesisMock.cancel).toHaveBeenCalled();
    expect(speechSynthesisMock.speak).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Read  and markdown',
    }));
  });

  it('supports playback rate, seek, skip, pause, and ended transitions', async () => {
    mockServerTtsSuccess();
    const { result } = renderHook(() =>
      useAudioPlayback({
        text: 'Controls',
        ttsApiUrl: 'https://api.example.com/api/tts',
        ttsStorageId: 'msg-3',
      })
    );

    await act(async () => {
      result.current.play();
    });
    await waitFor(() => expect(result.current.state).toBe('playing'));

    act(() => {
      result.current.setPlaybackRate(1.5);
      result.current.seekTo(10);
      result.current.skipForward(5);
      result.current.skipBackward(3);
      result.current.pause();
    });

    const audio = MockAudio.instances[0];
    expect(result.current.playbackRate).toBe(1.5);
    expect(audio?.playbackRate).toBe(1.5);
    expect(audio?.currentTime).toBe(12);
    expect(audio?.pause).toHaveBeenCalled();
    expect(result.current.state).toBe('paused');

    act(() => {
      audio?.onended?.();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.currentTime).toBe(0);
  });

  it('stops loading playback by aborting fetch work and resetting state', async () => {
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_url, init) => {
      capturedSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });

    const { result } = renderHook(() =>
      useAudioPlayback({
        text: 'Abort me',
        ttsApiUrl: 'https://api.example.com/api/tts',
        ttsStorageId: 'msg-4',
      })
    );

    act(() => {
      result.current.play();
    });
    await waitFor(() => expect(result.current.state).toBe('loading'));

    act(() => {
      result.current.stop();
    });

    expect(capturedSignal?.aborted).toBe(true);
    expect(result.current.state).toBe('idle');
    expect(result.current.currentTime).toBe(0);
  });

  it('cleans up audio, blob URLs, and speech synthesis on unmount', async () => {
    mockServerTtsSuccess();
    const { result, unmount } = renderHook(() =>
      useAudioPlayback({
        text: 'Cleanup',
        ttsApiUrl: 'https://api.example.com/api/tts',
        ttsStorageId: 'msg-5',
      })
    );

    await act(async () => {
      result.current.play();
    });
    await waitFor(() => expect(result.current.state).toBe('playing'));

    const audio = MockAudio.instances[0];
    unmount();

    expect(audio?.pause).toHaveBeenCalled();
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:tts-audio');
    expect(speechSynthesisMock.cancel).toHaveBeenCalled();
  });
});
