/**
 * Motion shared by the homepage hero and the feature scenes.
 *
 * The hero's pause control (WCAG 2.2.2) pauses every homepage animation, so the scenes read
 * the same page-wide flag instead of carrying their own controls.
 */
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
