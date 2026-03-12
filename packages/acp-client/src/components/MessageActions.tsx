import React, { useState, useCallback, useEffect, useRef } from 'react';

export interface MessageActionsProps {
  /** The plain text content of the message (used for TTS and word/char counts). */
  text: string;
  /** Unix-millisecond timestamp of the message. */
  timestamp: number;
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
 * - Speaker icon: reads the message aloud via Web Speech API
 */
export const MessageActions = React.memo(function MessageActions({ text, timestamp }: MessageActionsProps) {
  const [showMeta, setShowMeta] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const metaRef = useRef<HTMLDivElement>(null);
  const popoverId = React.useId();

  const plain = stripMarkdownForCount(text);
  const words = plain ? plain.split(/\s+/).filter(Boolean).length : 0;
  const chars = plain.length;

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

  const toggleSpeak = useCallback(() => {
    if (!window.speechSynthesis) return;

    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }

    // Cancel any ongoing speech first
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(plain);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
  }, [isSpeaking, plain]);

  // Clean up speech on unmount
  useEffect(() => {
    return () => {
      if (window.speechSynthesis && isSpeaking) {
        window.speechSynthesis.cancel();
      }
    };
  }, [isSpeaking]);

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
      {window.speechSynthesis && (
        <button
          type="button"
          onClick={toggleSpeak}
          className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded transition-colors"
          style={{
            color: isSpeaking ? 'var(--sam-color-accent-primary)' : 'var(--sam-color-fg-muted)',
            backgroundColor: isSpeaking ? 'var(--sam-color-bg-inset)' : undefined,
          }}
          aria-label={isSpeaking ? 'Stop reading' : 'Read aloud'}
          title={isSpeaking ? 'Stop reading' : 'Read aloud'}
        >
          {isSpeaking ? (
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
