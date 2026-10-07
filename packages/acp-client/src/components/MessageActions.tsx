import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAudioPlayback } from '../hooks/useAudioPlayback';
import { AudioPlayer } from './AudioPlayer';

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring,#34d399)]';

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
  /**
   * Edge of the message the actions sit on. 'end' right-aligns the buttons and
   * anchors the metadata popover to the right edge so it opens leftward, which
   * keeps it on screen under a right-aligned (user) bubble.
   */
  align?: 'start' | 'end';
  /**
   * Optional callback to delegate audio playback to an external player (e.g., global audio context).
   * When provided, the speaker button calls this instead of managing its own audio.
   * The inline AudioPlayer is not rendered — the external player handles UI.
   */
  onPlayAudio?: () => void;
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

/** Gap between the action row and the metadata popover. */
const POPOVER_GAP_PX = 4;

/**
 * Vertical range the popover can be seen in: the nearest ancestor that clips
 * overflow (the chat's scroll container), narrowed to the viewport.
 */
function visibleBounds(el: HTMLElement): { top: number; bottom: number } {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY !== 'visible') {
      const rect = node.getBoundingClientRect();
      return { top: Math.max(rect.top, 0), bottom: Math.min(rect.bottom, window.innerHeight) };
    }
  }
  return { top: 0, bottom: window.innerHeight };
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
 * - Info icon: shows metadata popover (timestamp, word count, char count) below
 *   the buttons, or above them when it would be cut off below
 * - Speaker icon: reads the message aloud via server-side TTS (preferred) or Web Speech API (fallback)
 * - Copy icon: copies message text to clipboard
 *
 * When audio playback starts, an AudioPlayer component is shown with seek,
 * speed control, and skip forward/backward.
 *
 * Use `hideTts` to suppress TTS (e.g., for user messages).
 * Use `variant="on-dark"` when rendered on a dark background (e.g., blue user bubbles).
 * Use `align="end"` under a right-aligned bubble (e.g., user messages).
 */
export const MessageActions = React.memo(function MessageActions({
  text,
  timestamp,
  ttsApiUrl,
  ttsStorageId,
  hideTts,
  variant = 'default',
  align = 'start',
  onPlayAudio,
}: MessageActionsProps) {
  const [showMeta, setShowMeta] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = React.useId();

  // When onPlayAudio is provided, we delegate audio to the global player.
  // The local hook is still called (hooks must be unconditional) but won't be used for playback.
  const audio = useAudioPlayback({ text, ttsApiUrl, ttsStorageId });
  const useGlobalPlayer = !!onPlayAudio;

  const plain = stripMarkdownForCount(text);
  const words = plain ? plain.split(/\s+/).filter(Boolean).length : 0;
  const chars = plain.length;

  const isOnDark = variant === 'on-dark';
  const isEnd = align === 'end';
  const colorMuted = isOnDark ? 'rgba(255,255,255,0.7)' : 'var(--sam-color-fg-muted)';
  const colorActive = isOnDark ? '#ffffff' : 'var(--sam-color-accent-primary)';

  // When delegating to global player, don't show the inline player
  const showPlayer = !useGlobalPlayer && !hideTts && (audio.state !== 'idle' || !!audio.lastError);
  const showSpeaker = !hideTts && (useGlobalPlayer || audio.hasServerTTS || (typeof window !== 'undefined' && !!window.speechSynthesis));

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

  // The popover opens below the buttons. Where that would cut it off (the
  // newest message sits right above the composer), open it upward if it fits.
  // A layout effect measures before paint, so the popover never flashes below.
  useLayoutEffect(() => {
    const anchor = metaRef.current;
    const popover = popoverRef.current;
    if (!showMeta || !anchor || !popover) {
      setOpenUpward(false);
      return;
    }
    const bounds = visibleBounds(anchor);
    const row = anchor.getBoundingClientRect();
    const height = popover.getBoundingClientRect().height;
    const fitsBelow = row.bottom + POPOVER_GAP_PX + height <= bounds.bottom;
    const fitsAbove = row.top - POPOVER_GAP_PX - height >= bounds.top;
    setOpenUpward(!fitsBelow && fitsAbove);
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
      <div className={`flex items-center gap-1${isEnd ? ' justify-end' : ''}`}>
        {/* Info button */}
        <button
          type="button"
          onClick={toggleMeta}
          className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded transition-colors ${FOCUS_RING}`}
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

        {/* TTS state announcements for screen readers (only when using local player) */}
        {!useGlobalPlayer && (
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {audio.state === 'loading' ? 'Generating audio' : audio.state === 'playing' ? 'Now playing' : ''}
          </span>
        )}

        {/* Speaker button */}
        {showSpeaker && (
          <button
            type="button"
            onClick={useGlobalPlayer ? onPlayAudio : audio.toggle}
            className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded transition-colors ${FOCUS_RING}`}
            style={{
              color: !useGlobalPlayer && audio.state !== 'idle' ? colorActive : colorMuted,
              backgroundColor: !useGlobalPlayer && audio.state === 'playing' ? 'var(--sam-color-bg-inset)' : undefined,
              opacity: !useGlobalPlayer && audio.state === 'loading' ? 0.7 : 1,
            }}
            aria-label={
              useGlobalPlayer ? 'Read aloud' :
              audio.state === 'loading' ? 'Cancel audio generation' :
              audio.state === 'playing' ? 'Pause' :
              audio.state === 'paused' ? 'Resume' :
              'Read aloud'
            }
            title={
              useGlobalPlayer ? 'Read aloud' :
              audio.state === 'loading' ? 'Cancel audio generation' :
              audio.state === 'playing' ? 'Pause' :
              audio.state === 'paused' ? 'Resume' :
              'Read aloud'
            }
          >
            {!useGlobalPlayer && audio.state === 'loading' ? (
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
            ) : !useGlobalPlayer && audio.state === 'playing' ? (
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
            ) : !useGlobalPlayer && audio.state === 'paused' ? (
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
            className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded transition-colors ${FOCUS_RING}`}
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
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-label="Message metadata"
          className={`absolute ${isEnd ? 'right-0' : 'left-0'} rounded-md shadow-md px-3 py-2 text-xs break-words`}
          style={{
            // Inline, not Tailwind utilities: the web app does not scan this
            // package for classes, so a utility used only here is never generated
            // (tasks/backlog/2026-10-04-acp-client-tailwind-classes-not-generated.md).
            ...(openUpward
              ? { bottom: '100%', marginBottom: POPOVER_GAP_PX }
              : { top: '100%', marginTop: POPOVER_GAP_PX }),
            // Size to the content, not to a narrow bubble.
            width: 'max-content',
            maxWidth: 'calc(100vw - 2rem)',
            // Above later messages; below the chat's z-10 chrome (floating
            // header, scroll button) when scrolled underneath it.
            zIndex: 5,
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
