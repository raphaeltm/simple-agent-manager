export interface StageTrackProps {
  stages: readonly string[];
  /** Index of the stage in progress (or the one that failed). */
  current: number;
  failed?: boolean;
}

const LIT_GREEN = 'linear-gradient(180deg, var(--sam-accent-top), var(--sam-accent-bottom))';
const LIT_RED = 'linear-gradient(180deg, var(--sam-status-danger-fg), var(--sam-color-danger))';

/**
 * Stage progress carved into the glass: a well with one segment per stage. Finished stages are
 * lit green, the current one is lit partway with a moving sheen (red when it failed), and the
 * rest are bare well. Stage names show under the track from the `sm` breakpoint; on phones the
 * notice title already names the current stage.
 */
export function StageTrack({ stages, current, failed = false }: Readonly<StageTrackProps>) {
  return (
    <div className="flex flex-col gap-2 sm:pl-11" data-testid="stage-track">
      <div className="sam-well flex gap-[3px] rounded-full p-[3px]" aria-hidden="true">
        {stages.map((stage, index) => {
          const done = index < current;
          const isCurrent = index === current;
          if (!done && !isCurrent) {
            return <div key={stage} className="h-1.5 flex-1 rounded-full" />;
          }
          const failedHere = failed && isCurrent;
          return (
            <div key={stage} className="relative h-1.5 flex-1 overflow-hidden rounded-full">
              <div
                data-stage-state={done ? 'done' : failedHere ? 'failed' : 'current'}
                className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ${
                  isCurrent && !failed ? 'sam-stage-shimmer w-[45%]' : 'w-full'
                }`}
                style={{
                  background: failedHere ? LIT_RED : LIT_GREEN,
                  boxShadow: `0 0 10px ${failedHere ? 'var(--sam-danger-edge)' : 'var(--sam-success-edge)'}`,
                }}
              />
            </div>
          );
        })}
      </div>
      <ol className="m-0 hidden list-none gap-[3px] p-0 sm:flex">
        {stages.map((stage, index) => {
          const done = index < current;
          const isCurrent = index === current;
          const tone = isCurrent
            ? failed
              ? 'font-medium text-[var(--sam-status-danger-fg)]'
              : 'font-medium text-fg-primary'
            : done
              ? 'text-[var(--sam-status-success-fg)]'
              : 'text-fg-muted';
          return (
            <li
              key={stage}
              aria-current={isCurrent ? 'step' : undefined}
              className={`min-w-0 flex-1 truncate px-1 text-[11.5px] ${tone}`}
            >
              {done && <span aria-hidden="true">✓ </span>}
              {stage}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
