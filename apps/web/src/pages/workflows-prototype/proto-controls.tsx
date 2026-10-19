/**
 * PROTOTYPE ONLY — scripted-time control. Runs are stored as snapshot frames;
 * this bar steps through them so a reviewer can watch a run progress, and the
 * screenshot script can target a frame with ?t=<frameId>.
 */
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

import { frameAt, frameIndexById, type RunDef } from './model';

/** Linear "story" frames exclude the branch frames reached only by actions. */
function storyFrames(run: RunDef) {
  return run.frames
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => !/-(rejected|cancelled|skipped)$/.test(f.id));
}

export function useRunFrame(run: RunDef) {
  const [params, setParams] = useSearchParams();
  const t = params.get('t');
  const index = t ? frameIndexById(run, t) : run.defaultFrame;
  const frame = frameAt(run, index);

  const goTo = useCallback(
    (frameId: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('t', frameId);
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  return { frame, index, goTo };
}

export function useParam(name: string) {
  const [params, setParams] = useSearchParams();
  const value = params.get(name);
  const set = useCallback(
    (v: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (v === null) next.delete(name);
          else next.set(name, v);
          return next;
        },
        { replace: true }
      );
    },
    [name, setParams]
  );
  return [value, set] as const;
}

/** Compact scripted-time controls rendered inside the PROTOTYPE strip. */
export function SimulationBar({ run }: { run: RunDef }) {
  const { frame, goTo } = useRunFrame(run);
  const story = useMemo(() => storyFrames(run), [run]);
  const pos = story.findIndex(({ f }) => f.id === frame.id);
  const prev = pos > 0 ? story[pos - 1] : undefined;
  const next = pos >= 0 && pos < story.length - 1 ? story[pos + 1] : undefined;
  if (run.frames.length < 2) return null;
  const btn =
    'w-5 h-5 rounded flex items-center justify-center bg-transparent border border-current/40 text-inherit disabled:opacity-30 cursor-pointer';

  return (
    <span className="inline-flex items-center gap-1.5 min-w-0" data-testid="simulation-bar">
      <span className="hidden sm:inline font-semibold">Simulate:</span>
      <button
        type="button"
        aria-label="Previous moment"
        disabled={!prev}
        onClick={() => prev && goTo(prev.f.id)}
        className={btn}
      >
        <ChevronLeft size={12} />
      </button>
      <span className="tabular-nums">{pos >= 0 ? `${pos + 1}/${story.length}` : '·'}</span>
      <button
        type="button"
        aria-label="Next moment"
        disabled={!next}
        onClick={() => next && goTo(next.f.id)}
        className={btn}
      >
        <ChevronRight size={12} />
      </button>
      <span className="hidden md:inline truncate max-w-[200px] opacity-90">{frame.caption}</span>
      <button
        type="button"
        aria-label="Back to the start"
        onClick={() => story[0] && goTo(story[0].f.id)}
        className={btn}
      >
        <RotateCcw size={10} />
      </button>
    </span>
  );
}
