import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from '@simple-agent-manager/ui';
import { useAudioPlayback, AudioPlayer } from '@simple-agent-manager/acp-client';
import { getTtsApiUrl } from '../../lib/api';

/** Lazily computed TTS API URL — avoids module-scope errors in test environments. */
let _cachedTtsApiUrl: string | undefined;
function getTtsUrl(): string {
  if (!_cachedTtsApiUrl) _cachedTtsApiUrl = getTtsApiUrl();
  return _cachedTtsApiUrl;
}

interface TruncatedSummaryProps {
  summary: string;
  /** Task ID used as TTS cache key. When provided, enables audio playback in the modal. */
  taskId?: string;
}

export const TruncatedSummary: FC<TruncatedSummaryProps> = ({ summary, taskId }) => {
  const textRef = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const audio = useAudioPlayback({
    text: summary,
    ttsApiUrl: taskId ? getTtsUrl() : undefined,
    ttsStorageId: taskId ? `task-${taskId}` : undefined,
  });

  const showSpeaker = taskId && (audio.hasServerTTS || (typeof window !== 'undefined' && !!window.speechSynthesis));
  const showPlayer = audio.state !== 'idle';

  const handleClose = useCallback(() => {
    audio.stop();
    setIsModalOpen(false);
  }, [audio]);

  const checkTruncation = useCallback(() => {
    const el = textRef.current;
    if (el) {
      setIsTruncated(el.scrollHeight > el.clientHeight);
    }
  }, []);

  useEffect(() => {
    checkTruncation();

    const el = textRef.current;
    if (!el) return;

    const observer = new ResizeObserver(checkTruncation);
    observer.observe(el);
    return () => observer.disconnect();
  }, [checkTruncation, summary]);

  return (
    <>
      <div className="px-4 py-2 bg-success-tint border-b border-border-default">
        <span className="sam-type-caption text-success font-medium">
          Summary:
        </span>{' '}
        <span
          ref={textRef}
          className="sam-type-caption text-fg-primary break-words line-clamp-2"
        >
          {summary}
        </span>
        {isTruncated && (
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="sam-type-caption text-accent-primary hover:text-accent-primary-hover cursor-pointer ml-1"
          >
            Read more
          </button>
        )}
      </div>

      <Dialog isOpen={isModalOpen} onClose={handleClose} maxWidth="lg">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 id="dialog-title" className="text-lg font-semibold text-fg-primary">
              Task Summary
            </h2>
            {showSpeaker && (
              <>
                <span className="sr-only" aria-live="polite" aria-atomic="true">
                  {audio.state === 'loading' ? 'Generating audio' : audio.state === 'playing' ? 'Now playing' : ''}
                </span>
                <button
                  type="button"
                  onClick={audio.toggle}
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded transition-colors hover:bg-[var(--sam-color-bg-inset)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-accent-primary,#16a34a)]"
                  style={{
                    color: audio.state !== 'idle' ? 'var(--sam-color-accent-primary)' : 'var(--sam-color-fg-muted)',
                    backgroundColor: audio.state === 'playing' ? 'var(--sam-color-bg-inset)' : undefined,
                    opacity: audio.state === 'loading' ? 0.7 : 1,
                  }}
                  aria-label={
                    audio.state === 'loading' ? 'Cancel audio generation' :
                    audio.state === 'playing' ? 'Pause' :
                    audio.state === 'paused' ? 'Resume' :
                    'Read summary aloud'
                  }
                  title={
                    audio.state === 'loading' ? 'Cancel audio generation' :
                    audio.state === 'playing' ? 'Pause' :
                    audio.state === 'paused' ? 'Resume' :
                    'Read summary aloud'
                  }
                >
                  {audio.state === 'loading' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="animate-spin motion-reduce:animate-none">
                      <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                    </svg>
                  ) : audio.state === 'playing' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
                      <rect x="6" y="4" width="4" height="16" rx="1" />
                      <rect x="14" y="4" width="4" height="16" rx="1" />
                    </svg>
                  ) : audio.state === 'paused' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    </svg>
                  )}
                </button>
              </>
            )}
          </div>

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
            />
          )}

          <p className="text-fg-primary whitespace-pre-wrap break-words">
            {summary}
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 rounded-md bg-surface-secondary hover:bg-surface-tertiary text-fg-primary text-sm font-medium cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
};
