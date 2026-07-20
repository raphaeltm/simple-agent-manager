import { Dialog } from '@simple-agent-manager/ui';
import { type FC, useCallback, useEffect, useRef, useState } from 'react';

import { useGlobalAudio } from '../../contexts/GlobalAudioContext';
import { getTtsApiUrl } from '../../lib/api';
import { RenderedMarkdown } from '../MarkdownRenderer';

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

  const globalAudio = useGlobalAudio();

  const showSpeaker = !!taskId;

  const handlePlayAudio = useCallback(() => {
    if (!taskId) return;
    globalAudio.startPlayback({
      text: summary,
      ttsApiUrl: getTtsUrl(),
      ttsStorageId: `task-${taskId}`,
      label: 'Task Summary',
      sourceText: summary.slice(0, 200),
    });
  }, [globalAudio, summary, taskId]);

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);

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
      <div
        className="glass-surface glass-composited relative mx-3 mt-2 px-4 py-2 rounded-xl border"
        style={{
          borderColor: 'rgba(34, 197, 94, 0.12)',
          background: 'linear-gradient(135deg, rgba(22, 163, 74, 0.08), var(--sam-glass-bg-surface))',
          boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25), 0 6px 12px -2px rgba(34, 197, 94, 0.15)',
        }}
      >
        {/* Same opacity scrim as SessionHeader/ErrorBanner: this card floats
            over the message scroller, where backdrop blur never applies. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 rounded-[inherit] -z-10 pointer-events-none"
          style={{ backgroundColor: 'color-mix(in srgb, var(--sam-color-bg-canvas) 78%, transparent)' }}
        />
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
            <h3 id="dialog-title" className="text-lg font-semibold text-fg-primary">
              Task Summary
            </h3>
            {showSpeaker && (
              <button
                type="button"
                onClick={handlePlayAudio}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded transition-colors hover:bg-[var(--sam-color-bg-inset)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-accent-primary,#16a34a)]"
                style={{ color: 'var(--sam-color-fg-muted)' }}
                aria-label="Read summary aloud"
                title="Read summary aloud"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              </button>
            )}
          </div>

          <RenderedMarkdown content={summary} inline />
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
