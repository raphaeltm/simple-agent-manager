import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';

/** Playback position polling interval — 4 Hz is smooth enough for the seek bar with low CPU cost. */
const TIME_UPDATE_INTERVAL_MS = 250;

export type GlobalAudioState = 'idle' | 'loading' | 'playing' | 'paused';

export interface StartPlaybackParams {
  /** Raw message text (possibly with markdown). */
  text: string;
  /** TTS API base URL (e.g., "https://api.example.com/api/tts"). */
  ttsApiUrl: string;
  /** Unique storage ID for caching TTS audio. */
  ttsStorageId: string;
  /** Display label (e.g., "Claude · Project Chat"). */
  label: string;
  /** Route to navigate back to source. */
  sourceHref?: string;
  /** Original text converted to audio. */
  sourceText?: string;
}

export interface GlobalAudioContextValue {
  state: GlobalAudioState;
  sourceLabel: string;
  sourceHref?: string;
  sourceText?: string;
  currentTime: number;
  duration: number;
  playbackRate: number;
  error: string | null;
  startPlayback: (params: StartPlaybackParams) => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  toggle: () => void;
  seekTo: (time: number) => void;
  skipForward: (seconds: number) => void;
  skipBackward: (seconds: number) => void;
  setPlaybackRate: (rate: number) => void;
}

const noop = () => {};

const GlobalAudioContext = createContext<GlobalAudioContextValue>({
  state: 'idle',
  sourceLabel: '',
  sourceHref: undefined,
  sourceText: undefined,
  currentTime: 0,
  duration: 0,
  playbackRate: 1,
  error: null,
  startPlayback: noop,
  play: noop,
  pause: noop,
  stop: noop,
  toggle: noop,
  seekTo: noop,
  skipForward: noop,
  skipBackward: noop,
  setPlaybackRate: noop,
});

export function useGlobalAudio(): GlobalAudioContextValue {
  return useContext(GlobalAudioContext);
}

/**
 * Strip markdown to plain text for browser TTS fallback.
 */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/[#*_~>|\\-]/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

export function GlobalAudioProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GlobalAudioState>('idle');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [sourceHref, setSourceHref] = useState<string | undefined>();
  const [sourceText, setSourceText] = useState<string | undefined>();

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const playbackLockRef = useRef(false);
  const timeUpdateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cachedStorageIdRef = useRef<string | null>(null);

  const clearTimeInterval = useCallback(() => {
    if (timeUpdateIntervalRef.current) {
      clearInterval(timeUpdateIntervalRef.current);
      timeUpdateIntervalRef.current = null;
    }
  }, []);

  const startTimeInterval = useCallback(() => {
    clearTimeInterval();
    timeUpdateIntervalRef.current = setInterval(() => {
      if (audioRef.current) {
        setCurrentTime(audioRef.current.currentTime);
      }
    }, TIME_UPDATE_INTERVAL_MS);
  }, [clearTimeInterval]);

  const abortFetches = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    abortFetches();
    clearTimeInterval();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    playbackLockRef.current = false;
    setState('idle');
    setCurrentTime(0);
    setDuration(0);
    setError(null);
  }, [abortFetches, clearTimeInterval]);

  const pause = useCallback(() => {
    clearTimeInterval();
    if (audioRef.current) {
      audioRef.current.pause();
      setState('paused');
    }
  }, [clearTimeInterval]);

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
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
        cachedStorageIdRef.current = null;
      }
    };

    return audio;
  }, [clearTimeInterval, playbackRate]);

  const startPlayback = useCallback((params: StartPlaybackParams) => {
    // Stop any current playback first
    abortFetches();
    clearTimeInterval();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    playbackLockRef.current = false;

    // Set source metadata
    setSourceLabel(params.label);
    setSourceHref(params.sourceHref);
    setSourceText(params.sourceText);
    setError(null);
    setCurrentTime(0);
    setDuration(0);

    const { text, ttsApiUrl, ttsStorageId } = params;

    // Re-entrance guard
    playbackLockRef.current = true;

    // If we have a cached blob URL for this storageId, reuse it
    if (blobUrlRef.current && cachedStorageIdRef.current === ttsStorageId) {
      const audio = createAudioElement(blobUrlRef.current);
      audioRef.current = audio;
      audio.play().then(() => {
        setState('playing');
        startTimeInterval();
      }).catch(() => {
        setState('idle');
        playbackLockRef.current = false;
      });
      return;
    }

    setState('loading');

    const controller = new AbortController();
    abortControllerRef.current = controller;

    (async () => {
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

        const { audioUrl } = await synthesizeRes.json() as { audioUrl: string; summarized?: boolean };

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
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setState('idle');
          playbackLockRef.current = false;
          return;
        }

        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error('TTS playback error:', errorMessage);
        setError(errorMessage);
        setState('idle');
        playbackLockRef.current = false;

        // Fall back to browser TTS on server failure
        if (typeof window !== 'undefined' && window.speechSynthesis) {
          window.speechSynthesis.cancel();
          const plain = stripMarkdown(text);
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
    })();
  }, [abortFetches, clearTimeInterval, createAudioElement, startTimeInterval]);

  const play = useCallback(() => {
    if (state === 'paused') {
      resumePlayback();
    }
  }, [state, resumePlayback]);

  const toggle = useCallback(() => {
    switch (state) {
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
  }, [state, stop, pause, resumePlayback]);

  const seekTo = useCallback((time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = Math.max(0, Math.min(time, audioRef.current.duration || 0));
      setCurrentTime(audioRef.current.currentTime);
    }
  }, []);

  const skipForward = useCallback((seconds: number) => {
    if (audioRef.current) {
      seekTo(audioRef.current.currentTime + seconds);
    }
  }, [seekTo]);

  const skipBackward = useCallback((seconds: number) => {
    if (audioRef.current) {
      seekTo(audioRef.current.currentTime - seconds);
    }
  }, [seekTo]);

  const setPlaybackRate = useCallback((rate: number) => {
    setPlaybackRateState(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  }, []);

  // Cleanup on unmount (should rarely happen since this is at app root)
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

  const value: GlobalAudioContextValue = {
    state,
    sourceLabel,
    sourceHref,
    sourceText,
    currentTime,
    duration,
    playbackRate,
    error,
    startPlayback,
    play,
    pause,
    stop,
    toggle,
    seekTo,
    skipForward,
    skipBackward,
    setPlaybackRate,
  };

  return (
    <GlobalAudioContext.Provider value={value}>
      {children}
    </GlobalAudioContext.Provider>
  );
}
