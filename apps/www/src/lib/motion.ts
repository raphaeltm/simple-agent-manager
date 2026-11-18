/**
 * Motion helpers shared by the brand guide (src/components/brand/brand-motion.ts): the media
 * queries it checks and a pointer follower for tilt.
 *
 * Top level must not touch browser globals; only function bodies may.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)';

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
