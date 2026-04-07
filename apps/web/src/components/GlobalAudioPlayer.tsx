import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import { useGlobalAudio } from '../contexts/GlobalAudioContext';
import { useIsMobile } from '../hooks/useIsMobile';

const SKIP_SECONDS = 15;
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring,#34d399)]';

/** Format seconds as m:ss or h:mm:ss. */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Global persistent audio player bar.
 * Renders at the bottom of AppShell when audio is active.
 * Survives page navigation because it lives above the router outlet.
 *
 * Layout: full-width seek bar on top, controls row below.
 */
export function GlobalAudioPlayer() {
  const audio = useGlobalAudio();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  const isVisible = audio.state !== 'idle';
  const isLoading = audio.state === 'loading';
  const isPlaying = audio.state === 'playing';
  const showSeekBar = isPlaying || audio.state === 'paused';

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      audio.seekTo(parseFloat(e.target.value));
    },
    [audio],
  );

  const handleSkipBack = useCallback(() => audio.skipBackward(SKIP_SECONDS), [audio]);
  const handleSkipForward = useCallback(() => audio.skipForward(SKIP_SECONDS), [audio]);

  const handleSpeedChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      audio.setPlaybackRate(parseFloat(e.target.value));
    },
    [audio],
  );

  const handleGoToSource = useCallback(() => {
    if (audio.sourceHref) {
      navigate(audio.sourceHref);
    }
  }, [audio.sourceHref, navigate]);

  if (!isVisible) return null;

  const controlsHeight = isMobile ? '56px' : '48px';
  const btnSize = isMobile ? 'min-w-[48px] min-h-[48px]' : 'min-w-[44px] min-h-[44px]';

  return (
    <div
      role="region"
      aria-label="Audio player"
      className="flex-shrink-0 z-player"
      style={{
        animation: 'sam-player-slide-in 200ms ease-out',
        backgroundColor: 'var(--sam-color-bg-surface)',
        borderTopWidth: '1px',
        borderTopStyle: 'solid',
        borderTopColor: 'var(--sam-color-border-default)',
      }}
    >
      {/* Full-width progress bar / seek bar at the top */}
      {showSeekBar ? (
        <div className="w-full" style={{ marginTop: '-1px' }}>
          <input
            type="range"
            min={0}
            max={audio.duration || 0}
            step={0.1}
            value={audio.currentTime}
            onChange={handleSeek}
            className="sam-player-seek w-full block cursor-pointer"
            style={{
              ['--seek-pct' as string]: `${audio.duration ? (audio.currentTime / audio.duration) * 100 : 0}%`,
            }}
            aria-label="Seek position"
            aria-valuemin={0}
            aria-valuemax={audio.duration}
            aria-valuenow={audio.currentTime}
            aria-valuetext={`${formatTime(audio.currentTime)} of ${formatTime(audio.duration)}`}
          />
        </div>
      ) : (
        /* Shimmer placeholder while loading */
        <div
          className="w-full overflow-hidden"
          style={{
            height: '3px',
            marginTop: '-1px',
            backgroundColor: isLoading ? 'var(--sam-color-bg-inset)' : 'transparent',
          }}
        >
          {isLoading && (
            <div
              className="h-full w-1/3 animate-pulse"
              style={{ backgroundColor: 'var(--sam-color-accent-primary, #16a34a)', opacity: 0.4 }}
            />
          )}
        </div>
      )}

      {/* Screen reader state announcements */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {isLoading ? 'Loading audio' : isPlaying ? 'Now playing' : audio.state === 'paused' ? 'Paused' : ''}
      </span>

      {/* Controls row */}
      <div
        className="flex items-center gap-1 px-2"
        style={{ height: controlsHeight }}
      >
        {/* Skip back */}
        <button
          type="button"
          onClick={handleSkipBack}
          disabled={isLoading || !showSeekBar}
          className={`${btnSize} flex items-center justify-center rounded transition-colors disabled:opacity-30 ${FOCUS_RING}`}
          style={{ color: 'var(--sam-color-fg-muted)' }}
          aria-label={`Skip back ${SKIP_SECONDS} seconds`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="11 19 2 12 11 5 11 19" />
            <polygon points="22 19 13 12 22 5 22 19" />
          </svg>
        </button>

        {/* Play/Pause */}
        <button
          type="button"
          onClick={audio.toggle}
          className={`${btnSize} flex items-center justify-center rounded-full transition-colors ${FOCUS_RING}`}
          style={{
            backgroundColor: 'var(--sam-color-accent-primary, #16a34a)',
            color: 'white',
            opacity: isLoading ? 0.7 : 1,
          }}
          aria-label={isLoading ? 'Cancel audio generation' : isPlaying ? 'Pause' : 'Play'}
        >
          {isLoading ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="animate-spin motion-reduce:animate-none">
              <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" strokeLinecap="round" />
            </svg>
          ) : isPlaying ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          )}
        </button>

        {/* Skip forward */}
        <button
          type="button"
          onClick={handleSkipForward}
          disabled={isLoading || !showSeekBar}
          className={`${btnSize} flex items-center justify-center rounded transition-colors disabled:opacity-30 ${FOCUS_RING}`}
          style={{ color: 'var(--sam-color-fg-muted)' }}
          aria-label={`Skip forward ${SKIP_SECONDS} seconds`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="13 19 22 12 13 5 13 19" />
            <polygon points="2 19 11 12 2 5 2 19" />
          </svg>
        </button>

        {/* Time display */}
        {showSeekBar && (
          <span
            className="text-[11px] tabular-nums shrink-0 ml-1"
            style={{ color: 'var(--sam-color-fg-muted)' }}
          >
            {formatTime(audio.currentTime)} / {formatTime(audio.duration)}
          </span>
        )}

        {/* Spacer pushes remaining items to the right */}
        <div className="flex-1" />

        {/* Source label */}
        {audio.sourceLabel && (
          <button
            type="button"
            onClick={handleGoToSource}
            disabled={!audio.sourceHref}
            className={`hidden min-[321px]:flex items-center gap-1 max-w-[120px] md:max-w-[200px] text-xs truncate transition-colors disabled:cursor-default min-h-[44px] ${FOCUS_RING}`}
            style={{ color: 'var(--sam-color-fg-muted)' }}
            aria-label={`Go to source: ${audio.sourceLabel}`}
            title={audio.sourceLabel}
          >
            <span className="truncate">{audio.sourceLabel}</span>
            {audio.sourceHref && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            )}
          </button>
        )}

        {/* Desktop-only: expand toggle for speed selector */}
        {!isMobile && (
          <button
            type="button"
            onClick={() => setExpanded(prev => !prev)}
            className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded transition-colors ${FOCUS_RING}`}
            style={{ color: 'var(--sam-color-fg-muted)' }}
            aria-label={expanded ? 'Collapse player' : 'Expand player'}
            aria-expanded={expanded}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 200ms' }}
            >
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
        )}

        {/* Close */}
        <button
          type="button"
          onClick={audio.stop}
          className={`${btnSize} flex items-center justify-center rounded transition-colors ${FOCUS_RING}`}
          style={{ color: 'var(--sam-color-fg-muted)' }}
          aria-label="Close player"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Expanded row (desktop only): source text + speed selector */}
      {!isMobile && expanded && (
        <div
          className="flex items-center gap-3 px-3 pb-1"
          style={{ borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'var(--sam-color-border-default)' }}
        >
          {audio.sourceText && (
            <p
              className="flex-1 text-[11px] line-clamp-2 m-0 min-w-0"
              style={{ color: 'var(--sam-color-fg-muted)' }}
              title={audio.sourceText}
            >
              {audio.sourceText}
            </p>
          )}
          <div className="flex items-center gap-1.5 shrink-0">
            <label className="text-[10px]" style={{ color: 'var(--sam-color-fg-muted)' }}>
              Speed
            </label>
            <select
              value={audio.playbackRate}
              onChange={handleSpeedChange}
              className="text-[10px] rounded px-1 py-0.5 cursor-pointer"
              style={{
                backgroundColor: 'var(--sam-color-bg-surface)',
                borderColor: 'var(--sam-color-border-default)',
                borderWidth: '1px',
                borderStyle: 'solid',
                color: 'var(--sam-color-fg-primary)',
              }}
              aria-label="Playback speed"
            >
              {SPEED_OPTIONS.map((speed) => (
                <option key={speed} value={speed}>{speed}x</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Error message */}
      {audio.error && (
        <div
          className="text-[11px] px-3 py-0.5"
          style={{ color: 'var(--sam-color-danger-fg)' }}
          role="alert"
        >
          {audio.error}
        </div>
      )}
    </div>
  );
}
