/**
 * Feature scene motion: load a scene's layers as it approaches, play its story once when it is
 * in view, then rest on the final frame.
 *
 * The markup's resting state is the final frame, so visitors without JavaScript or with
 * `prefers-reduced-motion` see it still. While a story plays, `data-playing` hides every element
 * whose step has not come (`[data-at]`) and shows transient ones while their step holds
 * (`[data-at]`..`[data-until]`); see FeatureScene.astro. Stories finish within 5 s, and the hero's
 * pause control stops them (WCAG 2.2.2).
 */
import { createPointerFollower, isMotionPaused, onMotionPauseChange } from '../motion';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)';
/**
 * A story starts once its scene reaches the middle of the viewport (this inset band), whatever
 * the scene's height: a ratio threshold could never be met by a scene taller than the screen,
 * which would leave it waiting in its intro frame.
 */
const START_BAND = '-30% 0px -30% 0px';
/** How far beyond the viewport a scene starts loading its images. */
const PRELOAD_MARGIN = '100% 0px';
/** Time after the last step before the scene hands back to its static markup. */
const SETTLE_MS = 800;
/** Pointer tilt range, in degrees. */
const TILT_DEG = { x: 4, y: 6 };

interface Timed {
  el: HTMLElement;
  at: number;
  until: number;
}

interface RingStop {
  at: number;
  box: [left: number, top: number, width: number, height: number];
}

interface Ring {
  el: HTMLElement;
  stops: RingStop[];
}

type State = 'waiting' | 'playing' | 'done';

function parseJson(raw: string | undefined): unknown {
  try {
    return JSON.parse(raw ?? 'null');
  } catch {
    return null;
  }
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function parseBeats(raw: string | undefined): number[] {
  const value = parseJson(raw);
  return Array.isArray(value) ? value.filter(isNumber) : [];
}

export function parseStops(raw: string | undefined): RingStop[] {
  const value = parseJson(raw);
  if (!Array.isArray(value)) return [];
  return value.flatMap((stop: unknown): RingStop[] => {
    const { at, box } = (stop ?? {}) as { at?: unknown; box?: unknown };
    if (!isNumber(at) || !Array.isArray(box) || box.length !== 4 || !box.every(isNumber)) return [];
    return [{ at, box: box as RingStop['box'] }];
  });
}

/** The stop a ring sits on at `step`: the last one whose step has come. */
export function ringStopAt(stops: RingStop[], step: number): RingStop | undefined {
  let current = stops[0];
  for (const stop of stops) if (stop.at <= step) current = stop;
  return current;
}

export function initScene(root: HTMLElement) {
  const beats = parseBeats(root.dataset.beats);
  const lastStep = beats.length;
  const stack = root.querySelector<HTMLElement>('[data-scene-stack]');
  const timed: Timed[] = Array.from(root.querySelectorAll<HTMLElement>('[data-at]'), (el) => ({
    el,
    at: Number(el.dataset.at),
    until: el.dataset.until === undefined ? Number.POSITIVE_INFINITY : Number(el.dataset.until),
  }));
  const rings: Ring[] = Array.from(root.querySelectorAll<HTMLElement>('[data-stops]'), (el) => ({
    el,
    stops: parseStops(el.dataset.stops),
  }));
  const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY);
  let timers: number[] = [];
  let state: State = 'waiting';
  let visible = false;

  const canPlay = () => !reducedMotion.matches && !isMotionPaused() && lastStep > 0;

  function showStep(step: number) {
    root.dataset.step = String(step);
    for (const { el, at, until } of timed) el.classList.toggle('is-on', step >= at && step < until);
    for (const ring of rings) {
      const stop = ringStopAt(ring.stops, step);
      if (!stop) continue;
      const [left, top, width, height] = stop.box;
      ring.el.style.setProperty('--ring-left', `${left}%`);
      ring.el.style.setProperty('--ring-top', `${top}%`);
      ring.el.style.setProperty('--ring-width', `${width}%`);
      ring.el.style.setProperty('--ring-height', `${height}%`);
    }
  }

  function clearTimers() {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  }

  /** Jumps straight to the static markup (the final frame), without transitions. */
  function rest() {
    clearTimers();
    root.setAttribute('data-motion-snap', '');
    root.removeAttribute('data-playing');
    root.removeAttribute('data-pose');
    delete root.dataset.step;
    for (const { el } of timed) el.classList.remove('is-on');
    void root.offsetHeight;
    root.removeAttribute('data-motion-snap');
  }

  /** The intro frame: everything waits for its step, layers spread apart. */
  function prepare() {
    root.setAttribute('data-motion-snap', '');
    root.setAttribute('data-playing', '');
    root.setAttribute('data-pose', 'exploded');
    showStep(0);
    void root.offsetHeight;
    root.removeAttribute('data-motion-snap');
  }

  function play() {
    state = 'playing';
    beats.forEach((ms, index) => {
      const step = index + 1;
      timers.push(
        window.setTimeout(() => {
          if (step === 1) root.removeAttribute('data-pose');
          showStep(step);
          if (step === lastStep) timers.push(window.setTimeout(finish, SETTLE_MS));
        }, ms)
      );
    });
  }

  function finish() {
    state = 'done';
    rest();
  }

  // Load images once the scene approaches the viewport (CSS backgrounds are not lazy by default).
  const nearby = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      root.setAttribute('data-near', '');
      nearby.disconnect();
    },
    { rootMargin: PRELOAD_MARGIN }
  );
  nearby.observe(root);

  const onScreen = new IntersectionObserver(
    ([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible && state === 'waiting' && canPlay()) play();
    },
    { rootMargin: START_BAND }
  );
  onScreen.observe(root);

  if (canPlay()) prepare();

  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches && state !== 'done') finish();
  });

  onMotionPauseChange((paused) => {
    if (paused) {
      // Playing stories end on their final frame; unseen ones show it until motion resumes.
      if (state === 'playing') finish();
      else if (state === 'waiting') rest();
      return;
    }
    if (state !== 'waiting' || !canPlay()) return;
    prepare();
    if (visible) play();
  });

  if (stack && window.matchMedia(FINE_POINTER_QUERY).matches) {
    const aim = createPointerFollower((x, y) => {
      stack.style.setProperty('--tilt-x', `${(-y * TILT_DEG.x).toFixed(2)}deg`);
      stack.style.setProperty('--tilt-y', `${(x * TILT_DEG.y).toFixed(2)}deg`);
      stack.style.setProperty('--hot-x', `${(x * 70 + 50).toFixed(1)}%`);
      stack.style.setProperty('--hot-y', `${(y * 70 + 40).toFixed(1)}%`);
    });
    root.addEventListener('pointermove', (event) => {
      if (reducedMotion.matches || isMotionPaused()) return;
      const box = root.getBoundingClientRect();
      aim(
        (event.clientX - box.left) / box.width - 0.5,
        (event.clientY - box.top) / box.height - 0.5
      );
    });
    root.addEventListener('pointerleave', () => aim(0, 0));
    onMotionPauseChange((paused) => {
      if (paused) aim(0, 0);
    });
  }
}
