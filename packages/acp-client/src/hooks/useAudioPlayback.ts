import { useCallback, useEffect,useRef, useState } from 'react';

export type AudioPlaybackState = 'idle' | 'loading' | 'playing' | 'paused';

export interface UseAudioPlaybackOptions {
  /** Raw message text (possibly with markdown). */
  text: string;
  /** TTS API base URL (e.g., "https://api.example.com/api/tts"). */
  ttsApiUrl?: string;
  /** Unique storage ID for caching TTS audio. */
  ttsStorageId?: string;
}

export interface UseAudioPlaybackReturn {
  state: AudioPlaybackState;
  /** Start or resume playback. */
  play: () => void;
  /** Pause playback (keeps position). */
  pause: () => void;
  /** Stop playback and reset to beginning. */
  stop: () => void;
  /** Toggle play/pause. If idle, starts playback. */
  toggle: () => void;
  /** Current playback position in seconds. */
  currentTime: number;
  /** Total duration in seconds (0 until audio is loaded). */
  duration: number;
  /** Current playback rate (default 1). */
  playbackRate: number;
  /** Set playback rate (0.5 to 2). */
  setPlaybackRate: (rate: number) => void;
  /** Seek to a specific time in seconds. */
  seekTo: (time: number) => void;
  /** Skip forward by N seconds. */
  skipForward: (seconds: number) => void;
  /** SkipBackward by N seconds. */
  skipBackward: (seconds: number) => void;
  /** Whether server TTS is available. */
  hasServerTTS: boolean;
  /** Whether the audio was generated from a summary (not verbatim text). */
  summarized: boolean;
  /** Current error message (null when no error). Cleared on next play attempt. */
  error: string | null;
  /** Last error message. Persists after state returns to idle until next successful play. */
  lastError: string | null;
}

/**
 * Custom hook for managing TTS audio playback with:
 * - AbortController for cancelling in-flight requests
 * - Re-entrance guard to prevent double playback
 * - Blob URL caching across play/stop cycles
 * - Full playback controls (seek, speed, skip)
 * - Error surfacing (error + lastError fields)
 */
export function useAudioPlayback({
  text,
  ttsApiUrl,
  ttsStorageId,
}: UseAudioPlaybackOptions): UseAudioPlaybackReturn {
  const [state, setState] = useState<AudioPlaybackState>('idle');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [summarized, setSummarized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const playbackLockRef = useRef(false);
  const timeUpdateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track the storageId that the cached blob URL corresponds to
  const cachedStorageIdRef = useRef<string | null>(null);

  const hasServerTTS = !!(ttsApiUrl && ttsStorageId);

  // Clear the time update interval
  const clearTimeInterval = useCallback(() => {
    if (timeUpdateIntervalRef.current) {
      clearInterval(timeUpdateIntervalRef.current);
      timeUpdateIntervalRef.current = null;
    }
  }, []);

  // Start polling currentTime while audio is playing
  const startTimeInterval = useCallback(() => {
    clearTimeInterval();
    timeUpdateIntervalRef.current = setInterval(() => {
      if (audioRef.current) {
        setCurrentTime(audioRef.current.currentTime);
      }
    }, 250);
  }, [clearTimeInterval]);

  // Abort any in-flight fetch requests
  const abortFetches = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  // Stop playback completely and reset position
  const stop = useCallback(() => {
    abortFetches();
    clearTimeInterval();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    // Cancel browser TTS if active
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    playbackLockRef.current = false;
    setState('idle');
    setCurrentTime(0);
  }, [abortFetches, clearTimeInterval]);

  // Pause playback (keep position)
  const pause = useCallback(() => {
    clearTimeInterval();
    if (audioRef.current) {
      audioRef.current.pause();
      setState('paused');
    }
  }, [clearTimeInterval]);

  // Resume playback from current position
  const resumePlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.play().then(() => {
        setState('playing');
        startTimeInterval();
      }).catch(() => {
        setState('idle');
      });
    }
  }, [startTimeInterval]);

  // Create and configure an Audio element from a blob URL
  const createAudioElement = useCallback((blobUrl: string): HTMLAudioElement => {
    const audio = new Audio(blobUrl);
    audio.playbackRate = playbackRate;

    audio.onloadedmetadata = () => {
      setDuration(audio.duration);
    };

    audio.onended = () => {
      clearTimeInterval();
      setState('idle');
      setCurrentTime(0);
      audioRef.current = null;
      playbackLockRef.current = false;
    };

    audio.onerror = () => {
      clearTimeInterval();
      setState('idle');
      setCurrentTime(0);
      audioRef.current = null;
      playbackLockRef.current = false;
      // Clean up blob URL on error
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
        cachedStorageIdRef.current = null;
      }
    };

    return audio;
  }, [clearTimeInterval, playbackRate]);

  // Play using server-side TTS
  const playServerTTS = useCallback(async () => {
    if (!ttsApiUrl || !ttsStorageId) return;

    // Re-entrance guard
    if (playbackLockRef.current) return;
    playbackLockRef.current = true;

    // Clear error on new play attempt
    setError(null);

    // If we have a cached blob URL for this storageId, reuse it
    if (blobUrlRef.current && cachedStorageIdRef.current === ttsStorageId) {
      const audio = createAudioElement(blobUrlRef.current);
      audioRef.current = audio;
      try {
        await audio.play();
        setState('playing');
        startTimeInterval();
        // Clear lastError on successful play
        setLastError(null);
      } catch {
        setState('idle');
        playbackLockRef.current = false;
      }
      return;
    }

    setState('loading');

    // Abort any previous in-flight requests
    abortFetches();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      // Step 1: Trigger synthesis
      const synthesizeRes = await fetch(`${ttsApiUrl}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text, storageId: ttsStorageId }),
        signal: controller.signal,
      });

      if (!synthesizeRes.ok) {
        const errData = await synthesizeRes.json().catch(() => null) as { message?: string } | null;
        throw new Error(errData?.message || `Synthesis failed: ${synthesizeRes.status}`);
      }

      const { audioUrl, summarized: wasSummarized } = await synthesizeRes.json() as { audioUrl: string; summarized?: boolean };
      setSummarized(wasSummarized ?? false);

      // Step 2: Fetch the audio blob
      const baseOrigin = new URL(ttsApiUrl).origin;
      const fullAudioUrl = `${baseOrigin}${audioUrl}`;

      const audioRes = await fetch(fullAudioUrl, {
        credentials: 'include',
        signal: controller.signal,
      });

      if (!audioRes.ok) {
        throw new Error(`Audio fetch failed: ${audioRes.status}`);
      }

      const audioBlob = await audioRes.blob();

      // Clean up previous blob URL if for a different storage ID
      if (blobUrlRef.current && cachedStorageIdRef.current !== ttsStorageId) {
        URL.revokeObjectURL(blobUrlRef.current);
      }

      const blobUrl = URL.createObjectURL(audioBlob);
      blobUrlRef.current = blobUrl;
      cachedStorageIdRef.current = ttsStorageId;

      // Check if we were aborted while waiting
      if (controller.signal.aborted) {
        URL.revokeObjectURL(blobUrl);
        blobUrlRef.current = null;
        cachedStorageIdRef.current = null;
        playbackLockRef.current = false;
        return;
      }

      // Step 3: Play audio
      const audio = createAudioElement(blobUrl);
      audioRef.current = audio;

      await audio.play();
      setState('playing');
      startTimeInterval();
      // Clear lastError on successful play
      setLastError(null);
    } catch (err) {
      // Don't log abort errors — they're intentional
      if (err instanceof DOMException && err.name === 'AbortError') {
        setState('idle');
        playbackLockRef.current = false;
        return;
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('TTS playback error:', errorMessage);
      setError(errorMessage);
      setLastError(errorMessage);
      setState('idle');
      playbackLockRef.current = false;

      // Fall back to browser TTS on server failure
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        const plain = text
          .replace(/```[\s\S]*?```/g, '')
          .replace(/`[^`]+`/g, '')
          .replace(/[#*_~>|\\-]/g, '')
          .replace(/\n+/g, ' ')
          .trim();
        const utterance = new SpeechSynthesisUtterance(plain);
        utterance.onend = () => {
          setState('idle');
          playbackLockRef.current = false;
        };
        utterance.onerror = () => {
          setState('idle');
          playbackLockRef.current = false;
        };
        window.speechSynthesis.speak(utterance);
        setState('playing');
      }
    }
  }, [ttsApiUrl, ttsStorageId, text, createAudioElement, abortFetches, startTimeInterval]);

  // Play using browser TTS (fallback)
  const playBrowserTTS = useCallback(() => {
    if (!window.speechSynthesis) return;
    if (playbackLockRef.current) return;
    playbackLockRef.current = true;

    // Clear error on new play attempt
    setError(null);

    window.speechSynthesis.cancel();
    const plain = text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/[#*_~>|\\-]/g, '')
      .replace(/\n+/g, ' ')
      .trim();
    const utterance = new SpeechSynthesisUtterance(plain);
    utterance.onend = () => {
      setState('idle');
      playbackLockRef.current = false;
    };
    utterance.onerror = () => {
      setState('idle');
      playbackLockRef.current = false;
    };
    window.speechSynthesis.speak(utterance);
    setState('playing');
  }, [text]);

  // Main play function
  const play = useCallback(() => {
    if (state === 'paused') {
      resumePlayback();
      return;
    }

    if (state !== 'idle') return;

    if (hasServerTTS) {
      playServerTTS();
    } else if (typeof window !== 'undefined' && window.speechSynthesis) {
      playBrowserTTS();
    }
  }, [state, hasServerTTS, playServerTTS, playBrowserTTS, resumePlayback]);

  // Toggle play/pause/stop
  const toggle = useCallback(() => {
    switch (state) {
      case 'idle':
        play();
        break;
      case 'loading':
        stop();
        break;
      case 'playing':
        pause();
        break;
      case 'paused':
        resumePlayback();
        break;
    }
  }, [state, play, stop, pause, resumePlayback]);

  // Seek to a specific time
  const seekTo = useCallback((time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = Math.max(0, Math.min(time, audioRef.current.duration || 0));
      setCurrentTime(audioRef.current.currentTime);
    }
  }, []);

  // Skip forward
  const skipForward = useCallback((seconds: number) => {
    if (audioRef.current) {
      seekTo(audioRef.current.currentTime + seconds);
    }
  }, [seekTo]);

  // Skip backward
  const skipBackward = useCallback((seconds: number) => {
    if (audioRef.current) {
      seekTo(audioRef.current.currentTime - seconds);
    }
  }, [seekTo]);

  // Set playback rate
  const setPlaybackRate = useCallback((rate: number) => {
    setPlaybackRateState(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortFetches();
      clearTimeInterval();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      playbackLockRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    play,
    pause,
    stop,
    toggle,
    currentTime,
    duration,
    playbackRate,
    setPlaybackRate,
    seekTo,
    skipForward,
    skipBackward,
    hasServerTTS,
    summarized,
    error,
    lastError,
  };
}
