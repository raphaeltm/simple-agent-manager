/**
 * Motion shared by the homepage hero and the feature scenes.
 *
 * The hero's pause control (WCAG 2.2.2) pauses every homepage animation, so the scenes read the
 * same page-wide flag instead of carrying their own controls. The story budget below is shared
 * by the scene validator (src/data/scenes) and the scene runtime, so both enforce one number.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)';

/**
 * WCAG 2.2.2: motion that starts on its own and runs longer than 5 s needs a pause control.
 * A scene's story (its last step plus that step's motion) finishes within this budget.
 */
export const MAX_STORY_MS = 5000;
/**
 * Longest a step's motion runs once the step starts. Every transition a step starts in
 * FeatureScene.astro stays within it (layer rise 900 ms, tiles 520 ms plus up to 440 ms of
 * stagger, lights and crossfade 700 ms, highlights 360 ms); the runtime rests one settle after
 * the last step.
 */
export const STEP_SETTLE_MS = 1000;

type PauseListener = (paused: boolean) => void;

const pauseListeners = new Set<PauseListener>();
let motionPaused = false;

export const isMotionPaused = () => motionPaused;

export function setMotionPaused(paused: boolean) {
  if (paused === motionPaused) return;
  motionPaused = paused;
  for (const listener of pauseListeners) listener(paused);
}

export function onMotionPauseChange(listener: PauseListener) {
  pauseListeners.add(listener);
  return () => pauseListeners.delete(listener);
}

/** Finite numbers from a JSON array held in a data attribute; anything malformed reads as []. */
export function parseNumbers(raw: string | undefined): number[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value)
      ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
      : [];
  } catch {
    return [];
  }
}

export type Beat = readonly [atMs: number, run: () => void];

/** Runs a list of callbacks at offsets from now; `stop` cancels the ones still pending. */
export class Timeline {
  private timers: number[] = [];

  play(beats: readonly Beat[]) {
    this.stop();
    for (const [at, run] of beats) this.timers.push(window.setTimeout(run, at));
  }

  stop() {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers = [];
  }
}

/**
 * Eases a value pair toward a pointer target, one step per frame, and stops once settled, so a
 * pointer-driven tilt costs nothing at rest. Returns the function that sets the target.
 */
export function createPointerFollower(apply: (x: number, y: number) => void, ease = 0.1) {
  let targetX = 0;
  let targetY = 0;
  let x = 0;
  let y = 0;
  let raf = 0;
  const step = () => {
    x += (targetX - x) * ease;
    y += (targetY - y) * ease;
    apply(x, y);
    raf = Math.abs(targetX - x) + Math.abs(targetY - y) > 0.0005 ? requestAnimationFrame(step) : 0;
  };
  return (nextX: number, nextY: number) => {
    targetX = nextX;
    targetY = nextY;
    raf ||= requestAnimationFrame(step);
  };
}
