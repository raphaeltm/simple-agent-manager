import React, { useState, useCallback, useEffect, useRef } from 'react';

export interface MessageActionsProps {
  /** The plain text content of the message (used for TTS and word/char counts). */
  text: string;
  /** Unix-millisecond timestamp of the message. */
  timestamp: number;
  /** Optional TTS API base URL (e.g., "https://api.example.com/api/tts").
   *  When provided, uses server-side TTS via Cloudflare Workers AI.
   *  When absent, falls back to browser speechSynthesis. */
  ttsApiUrl?: string;
  /** Unique storage ID for caching TTS audio (e.g., message ID). Required when ttsApiUrl is set. */
  ttsStorageId?: string;
}

/** Strips markdown syntax for a cleaner word/char count and TTS reading. */
function stripMarkdownForCount(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '') // fenced code blocks
    .replace(/`[^`]+`/g, '')        // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => m.replace(/\[([^\]]*)\]\([^)]*\)/, '$1')) // links → text
    .replace(/[#*_~>|\\-]/g, '')    // markdown chars
    .replace(/\n+/g, ' ')
    .trim();
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Action buttons displayed below agent messages.
 * - Info icon: shows metadata popover (timestamp, word count, char count)
 * - Speaker icon: reads the message aloud via server-side TTS (preferred) or Web Speech API (fallback)
 * - Copy icon: copies message text to clipboard
 */
export const MessageActions = React.memo(function MessageActions({
  text,
  timestamp,
  ttsApiUrl,
  ttsStorageId,
}: MessageActionsProps) {
  const [showMeta, setShowMeta] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const popoverId = React.useId();

  const plain = stripMarkdownForCount(text);
  const words = plain ? plain.split(/\s+/).filter(Boolean).length : 0;
  const chars = plain.length;

  const useServerTTS = !!(ttsApiUrl && ttsStorageId);

  // Close metadata popover on outside click or Escape key
  useEffect(() => {
    if (!showMeta) return;
    function handleClick(e: MouseEvent) {
      if (metaRef.current && !metaRef.current.contains(e.target as Node)) {
        setShowMeta(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setShowMeta(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showMeta]);

  const toggleMeta = useCallback(() => {
    setShowMeta((v) => !v);
  }, []);

  // Stop audio playback (works for both server TTS and browser TTS)
  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
    setIsLoading(false);
  }, []);

  // Server-side TTS: call API to synthesize, then fetch audio and play
  const playServerTTS = useCallback(async () => {
    if (!ttsApiUrl || !ttsStorageId) return;

    setIsLoading(true);

    try {
      // Step 1: Trigger synthesis (may return cached)
      const synthesizeRes = await fetch(`${ttsApiUrl}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text, storageId: ttsStorageId }),
      });

      if (!synthesizeRes.ok) {
        const errData = await synthesizeRes.json().catch(() => null);
        throw new Error(errData?.message || `Synthesis failed: ${synthesizeRes.status}`);
      }

      const { audioUrl } = await synthesizeRes.json() as { audioUrl: string };

      // Step 2: Fetch the audio blob
      // Build absolute URL from the relative path returned by the API
      const baseOrigin = new URL(ttsApiUrl).origin;
      const fullAudioUrl = `${baseOrigin}${audioUrl}`;

      const audioRes = await fetch(fullAudioUrl, {
        credentials: 'include',
      });

      if (!audioRes.ok) {
        throw new Error(`Audio fetch failed: ${audioRes.status}`);
      }

      const audioBlob = await audioRes.blob();
      const blobUrl = URL.createObjectURL(audioBlob);

      // Clean up previous blob URL
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
      blobUrlRef.current = blobUrl;

      // Step 3: Play audio
      const audio = new Audio(blobUrl);
      audioRef.current = audio;

      audio.onended = () => {
        setIsSpeaking(false);
        audioRef.current = null;
      };
      audio.onerror = () => {
        setIsSpeaking(false);
        setIsLoading(false);
        audioRef.current = null;
      };

      await audio.play();
      setIsLoading(false);
      setIsSpeaking(true);
    } catch (err) {
      console.error('TTS playback error:', err);
      setIsLoading(false);
      setIsSpeaking(false);
    }
  }, [ttsApiUrl, ttsStorageId, text]);

  // Browser-native TTS fallback
  const playBrowserTTS = useCallback(() => {
    if (!window.speechSynthesis) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(plain);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
  }, [plain]);

  const toggleSpeak = useCallback(() => {
    if (isSpeaking || isLoading) {
      stopPlayback();
      return;
    }

    if (useServerTTS) {
      playServerTTS();
    } else if (window.speechSynthesis) {
      playBrowserTTS();
    }
  }, [isSpeaking, isLoading, useServerTTS, playServerTTS, playBrowserTTS, stopPlayback]);

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
    }, () => {
      // Clipboard write failed (e.g., permission denied) — silently ignore
    });
  }, [text]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
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
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // Show speaker button if server TTS is available OR browser TTS is available
  const showSpeaker = useServerTTS || (typeof window !== 'undefined' && !!window.speechSynthesis);

  return (
    <div className="flex items-center gap-1 mt-1 relative" ref={metaRef}>
      {/* Info button */}
      <button
        type="button"
        onClick={toggleMeta}
        className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded transition-colors"
        style={{
          color: showMeta ? 'var(--sam-color-accent-primary)' : 'var(--sam-color-fg-muted)',
        }}
        aria-label="Message info"
        title="Message info"
        aria-expanded={showMeta}
        aria-controls={showMeta ? popoverId : undefined}
        aria-haspopup="true"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      </button>

      {/* Speaker button */}
      {showSpeaker && (
        <button
          type="button"
          onClick={toggleSpeak}
          disabled={isLoading}
          className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded transition-colors"
          style={{
            color: (isSpeaking || isLoading) ? 'var(--sam-color-accent-primary)' : 'var(--sam-color-fg-muted)',
            backgroundColor: isSpeaking ? 'var(--sam-color-bg-inset)' : undefined,
            opacity: isLoading ? 0.7 : 1,
          }}
          aria-label={isLoading ? 'Generating audio...' : isSpeaking ? 'Stop reading' : 'Read aloud'}
          title={isLoading ? 'Generating audio...' : isSpeaking ? 'Stop reading' : 'Read aloud'}
        >
          {isLoading ? (
            // Loading spinner
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
              className="animate-spin"
            >
              <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" strokeLinecap="round" />
            </svg>
          ) : isSpeaking ? (
            // Stop/square icon
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="none"
              aria-hidden="true"
            >
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          ) : (
            // Volume/speaker icon
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </svg>
          )}
        </button>
      )}

      {/* Copy button */}
      {navigator.clipboard && (
        <button
          type="button"
          onClick={handleCopy}
          className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded transition-colors"
          style={{
            color: copied ? 'var(--sam-color-accent-primary)' : 'var(--sam-color-fg-muted)',
          }}
          aria-label={copied ? 'Copied' : 'Copy message'}
          title={copied ? 'Copied' : 'Copy message'}
        >
          {copied ? (
            // Check icon
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            // Clipboard/copy icon
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      )}

      {/* Metadata popover */}
      {showMeta && (
        <div
          id={popoverId}
          role="tooltip"
          aria-label="Message metadata"
          className="absolute left-0 top-full mt-1 z-10 rounded-md shadow-md px-3 py-2 text-xs max-w-[calc(100vw-2rem)] break-words"
          style={{
            backgroundColor: 'var(--sam-color-bg-surface, white)',
            borderColor: 'var(--sam-color-border-default, #e5e7eb)',
            borderWidth: '1px',
            borderStyle: 'solid',
            color: 'var(--sam-color-fg-muted)',
          }}
        >
          <div className="flex flex-col gap-1">
            <div>
              <span className="font-medium" style={{ color: 'var(--sam-color-fg-muted)' }}>Time:</span>{' '}
              {formatTimestamp(timestamp)}
            </div>
            <div>
              <span className="font-medium" style={{ color: 'var(--sam-color-fg-muted)' }}>Words:</span>{' '}
              {words.toLocaleString()}
            </div>
            <div>
              <span className="font-medium" style={{ color: 'var(--sam-color-fg-muted)' }}>Characters:</span>{' '}
              {chars.toLocaleString()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
