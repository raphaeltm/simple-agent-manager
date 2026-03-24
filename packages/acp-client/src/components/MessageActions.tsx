import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAudioPlayback } from '../hooks/useAudioPlayback';
import { AudioPlayer } from './AudioPlayer';

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
  /** When true, hides the TTS speaker button and audio player. Used for user messages. */
  hideTts?: boolean;
  /** Color variant. 'default' for light backgrounds, 'on-dark' for dark (e.g., blue) backgrounds. */
  variant?: 'default' | 'on-dark';
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
 * Action buttons displayed below messages.
 * - Info icon: shows metadata popover (timestamp, word count, char count)
 * - Speaker icon: reads the message aloud via server-side TTS (preferred) or Web Speech API (fallback)
 * - Copy icon: copies message text to clipboard
 *
 * When audio playback starts, an AudioPlayer component is shown with seek,
 * speed control, and skip forward/backward.
 *
 * Use `hideTts` to suppress TTS (e.g., for user messages).
 * Use `variant="on-dark"` when rendered on a dark background (e.g., blue user bubbles).
 */
export const MessageActions = React.memo(function MessageActions({
  text,
  timestamp,
  ttsApiUrl,
  ttsStorageId,
  hideTts,
  variant = 'default',
}: MessageActionsProps) {
  const [showMeta, setShowMeta] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaRef = useRef<HTMLDivElement>(null);
  const popoverId = React.useId();

  const audio = useAudioPlayback({ text, ttsApiUrl, ttsStorageId });

  const plain = stripMarkdownForCount(text);
  const words = plain ? plain.split(/\s+/).filter(Boolean).length : 0;
  const chars = plain.length;

  const isOnDark = variant === 'on-dark';
  const colorMuted = isOnDark ? 'rgba(255,255,255,0.7)' : 'var(--sam-color-fg-muted)';
  const colorActive = isOnDark ? '#ffffff' : 'var(--sam-color-accent-primary)';

  const showPlayer = !hideTts && (audio.state !== 'idle' || !!audio.lastError);
  const showSpeaker = !hideTts && (audio.hasServerTTS || (typeof window !== 'undefined' && !!window.speechSynthesis));

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

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
    }, () => {
      // Clipboard write failed — silently ignore
    });
  }, [text]);

  // Clean up copy timer on unmount
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  return (
    <div className="flex flex-col mt-1 relative" ref={metaRef}>
      <div className="flex items-center gap-1">
        {/* Info button */}
        <button
          type="button"
          onClick={toggleMeta}
          className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded transition-colors"
          style={{
            color: showMeta ? colorActive : colorMuted,
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

        {/* TTS state announcements for screen readers */}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {audio.state === 'loading' ? 'Generating audio' : audio.state === 'playing' ? 'Now playing' : ''}
        </span>

        {/* Speaker button */}
        {showSpeaker && (
          <button
            type="button"
            onClick={audio.toggle}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded transition-colors"
            style={{
              color: audio.state !== 'idle' ? colorActive : colorMuted,
              backgroundColor: audio.state === 'playing' ? 'var(--sam-color-bg-inset)' : undefined,
              opacity: audio.state === 'loading' ? 0.7 : 1,
            }}
            aria-label={
              audio.state === 'loading' ? 'Cancel audio generation' :
              audio.state === 'playing' ? 'Pause' :
              audio.state === 'paused' ? 'Resume' :
              'Read aloud'
            }
            title={
              audio.state === 'loading' ? 'Cancel audio generation' :
              audio.state === 'playing' ? 'Pause' :
              audio.state === 'paused' ? 'Resume' :
              'Read aloud'
            }
          >
            {audio.state === 'loading' ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              >
                <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" strokeLinecap="round" />
              </svg>
            ) : audio.state === 'playing' ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="none"
                aria-hidden="true"
              >
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : audio.state === 'paused' ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="none"
                aria-hidden="true"
              >
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            ) : (
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
        {typeof navigator !== 'undefined' && navigator.clipboard && (
          <button
            type="button"
            onClick={handleCopy}
            className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded transition-colors"
            style={{
              color: copied ? colorActive : colorMuted,
            }}
            aria-label={copied ? 'Copied' : 'Copy message'}
            title={copied ? 'Copied' : 'Copy message'}
          >
            {copied ? (
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
      </div>

      {/* Audio Player UI */}
      {showPlayer && (
        <AudioPlayer
          state={audio.state}
          currentTime={audio.currentTime}
          duration={audio.duration}
          playbackRate={audio.playbackRate}
          onToggle={audio.toggle}
          onStop={audio.stop}
          onSeek={audio.seekTo}
          onSkipForward={audio.skipForward}
          onSkipBackward={audio.skipBackward}
          onPlaybackRateChange={audio.setPlaybackRate}
          error={audio.lastError}
        />
      )}

      {/* Metadata popover */}
      {showMeta && (
        <div
          id={popoverId}
          role="dialog"
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
