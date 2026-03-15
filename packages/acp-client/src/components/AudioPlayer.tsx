import React, { useCallback } from 'react';
import type { AudioPlaybackState } from '../hooks/useAudioPlayback';

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-accent-primary,#16a34a)]';

export interface AudioPlayerProps {
  state: AudioPlaybackState;
  currentTime: number;
  duration: number;
  playbackRate: number;
  onToggle: () => void;
  onStop: () => void;
  onSeek: (time: number) => void;
  onSkipForward: (seconds: number) => void;
  onSkipBackward: (seconds: number) => void;
  onPlaybackRateChange: (rate: number) => void;
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SKIP_SECONDS = 10;

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
 * Audio playback UI overlay with seek bar, speed control, and skip buttons.
 * Appears as a compact floating bar below the message actions.
 */
export const AudioPlayer = React.memo(function AudioPlayer({
  state,
  currentTime,
  duration,
  playbackRate,
  onToggle,
  onStop,
  onSeek,
  onSkipForward,
  onSkipBackward,
  onPlaybackRateChange,
}: AudioPlayerProps) {
  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onSeek(parseFloat(e.target.value));
    },
    [onSeek],
  );

  const handleSkipBack = useCallback(() => onSkipBackward(SKIP_SECONDS), [onSkipBackward]);
  const handleSkipForward = useCallback(() => onSkipForward(SKIP_SECONDS), [onSkipForward]);

  const handleSpeedChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onPlaybackRateChange(parseFloat(e.target.value));
    },
    [onPlaybackRateChange],
  );

  const speedId = React.useId();

  const isLoading = state === 'loading';
  const isPlaying = state === 'playing';
  const isPaused = state === 'paused';
  const showSeekBar = isPlaying || isPaused;

  return (
    <div
      className="flex flex-col gap-1.5 mt-2 rounded-lg px-3 py-2 w-full"
      style={{
        backgroundColor: 'var(--sam-color-bg-inset, #f3f4f6)',
        borderColor: 'var(--sam-color-border-default, #e5e7eb)',
        borderWidth: '1px',
        borderStyle: 'solid',
      }}
      role="region"
      aria-label="Audio player"
    >
      {/* Controls row */}
      <div className="flex items-center gap-2">
        {/* Skip back */}
        <button
          type="button"
          onClick={handleSkipBack}
          disabled={isLoading || !showSeekBar}
          className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded transition-colors disabled:opacity-30 ${FOCUS_RING}`}
          style={{ color: 'var(--sam-color-fg-muted)' }}
          aria-label={`Skip back ${SKIP_SECONDS} seconds`}
          title={`Skip back ${SKIP_SECONDS}s`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="11 19 2 12 11 5 11 19" />
            <polygon points="22 19 13 12 22 5 22 19" />
          </svg>
        </button>

        {/* Play/Pause toggle */}
        <button
          type="button"
          onClick={onToggle}
          className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full transition-colors ${FOCUS_RING}`}
          style={{
            backgroundColor: 'var(--sam-color-accent-primary, #16a34a)',
            color: 'white',
            opacity: isLoading ? 0.7 : 1,
          }}
          aria-label={isLoading ? 'Cancel audio generation' : isPlaying ? 'Pause' : 'Play'}
          title={isLoading ? 'Cancel' : isPlaying ? 'Pause' : 'Play'}
        >
          {isLoading ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="animate-spin motion-reduce:animate-none">
              <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" strokeLinecap="round" />
            </svg>
          ) : isPlaying ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          )}
        </button>

        {/* Skip forward */}
        <button
          type="button"
          onClick={handleSkipForward}
          disabled={isLoading || !showSeekBar}
          className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded transition-colors disabled:opacity-30 ${FOCUS_RING}`}
          style={{ color: 'var(--sam-color-fg-muted)' }}
          aria-label={`Skip forward ${SKIP_SECONDS} seconds`}
          title={`Skip forward ${SKIP_SECONDS}s`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="13 19 22 12 13 5 13 19" />
            <polygon points="2 19 11 12 2 5 2 19" />
          </svg>
        </button>

        {/* Close/stop button */}
        <button
          type="button"
          onClick={onStop}
          className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded transition-colors ml-auto ${FOCUS_RING}`}
          style={{ color: 'var(--sam-color-fg-muted)' }}
          aria-label="Close player"
          title="Close player"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Seek bar + time display */}
      {showSeekBar && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] tabular-nums min-w-[32px] text-right" style={{ color: 'var(--sam-color-fg-muted)' }}>
            {formatTime(currentTime)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
            className="flex-1 h-1 accent-[var(--sam-color-accent-primary,#16a34a)] cursor-pointer"
            aria-label="Seek position"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={currentTime}
            aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
          />
          <span className="text-[10px] tabular-nums min-w-[32px]" style={{ color: 'var(--sam-color-fg-muted)' }}>
            {formatTime(duration)}
          </span>
        </div>
      )}

      {/* Speed selector (always visible when player is open) */}
      <div className="flex items-center gap-2 justify-end">
        <label className="text-[10px]" style={{ color: 'var(--sam-color-fg-muted)' }} htmlFor={speedId}>
          Speed
        </label>
        <select
          id={speedId}
          value={playbackRate}
          onChange={handleSpeedChange}
          className="text-[10px] rounded px-1 py-0.5 cursor-pointer"
          style={{
            backgroundColor: 'var(--sam-color-bg-surface, white)',
            borderColor: 'var(--sam-color-border-default, #e5e7eb)',
            borderWidth: '1px',
            borderStyle: 'solid',
            color: 'var(--sam-color-fg-default)',
          }}
          aria-label="Playback speed"
        >
          {SPEED_OPTIONS.map((speed) => (
            <option key={speed} value={speed}>
              {speed}x
            </option>
          ))}
        </select>
      </div>
    </div>
  );
});
