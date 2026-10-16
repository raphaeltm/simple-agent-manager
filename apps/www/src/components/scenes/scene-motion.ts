/**
 * Feature scene motion: load a scene's layers as it approaches, play its story once when it
 * reaches the middle of the screen, then rest on the final frame.
 *
 * The markup's resting state is the final frame, so visitors without JavaScript or with
 * `prefers-reduced-motion` see it still. While a story plays, `data-playing` hides every element
 * whose step has not come (`[data-at]`) and shows transient ones only while their step holds
 * (`[data-at]`..`[data-until]`); see FeatureScene.astro. A story ends within MAX_STORY_MS, and
 * rests early on its final frame when its scene leaves the screen, the tab is hidden, or the
 * hero's pause control is pressed (WCAG 2.2.2).
 */
import {
  type Beat,
  createPointerFollower,
  FINE_POINTER_QUERY,
  isMotionPaused,
  onMotionPauseChange,
  parseNumbers,
  REDUCED_MOTION_QUERY,
  STEP_SETTLE_MS,
  Timeline,
} from '../../lib/motion';

/** How far beyond the viewport a scene starts loading its images. */
const PRELOAD_MARGIN = '100% 0px';
/**
 * A story starts once its scene reaches the middle of the viewport (this inset band), whatever
 * the scene's height: a ratio threshold could never be met by a scene much taller than the
 * screen, which would leave it waiting in its intro frame.
 */
const START_BAND = '-30% 0px -30% 0px';
/** Pointer tilt range, in degrees. */
const TILT_DEG = { x: 4, y: 6 };

type State = 'waiting' | 'playing' | 'done';

interface Timed {
  el: HTMLElement;
  at: number;
  until: number;
}

class SceneStory {
  state: State = 'waiting';
  /** Whether the scene is in the start band right now. */
  inBand = false;
  private readonly beats: number[];
  private readonly timed: Timed[];
  private readonly timeline = new Timeline();

  constructor(
    readonly root: HTMLElement,
    private readonly motionAllowed: () => boolean,
    private readonly onDone: (story: SceneStory) => void
  ) {
    this.beats = parseNumbers(root.dataset.beats);
    this.timed = Array.from(root.querySelectorAll<HTMLElement>('[data-at]'), (el) => ({
      el,
      at: Number(el.dataset.at),
      until: el.dataset.until === undefined ? Number.POSITIVE_INFINITY : Number(el.dataset.until),
    }));
    if (this.canPlay()) this.prepare();
  }

  private canPlay() {
    return this.beats.length > 0 && this.motionAllowed();
  }

  /** Applies a change with transitions off, so jumping between frames does not animate. */
  private snap(change: () => void) {
    this.root.setAttribute('data-motion-snap', '');
    change();
    void this.root.offsetHeight;
    this.root.removeAttribute('data-motion-snap');
  }

  private showStep(step: number) {
    this.root.dataset.step = String(step);
    for (const { el, at, until } of this.timed) {
      el.classList.toggle('is-on', step >= at && step < until);
    }
  }

  /** The intro frame: everything waits for its step, layers spread apart. */
  private prepare() {
    this.snap(() => {
      this.root.setAttribute('data-playing', '');
      this.root.setAttribute('data-pose', 'exploded');
      this.showStep(0);
    });
  }

  /** Jumps straight to the static markup, which is the final frame. */
  private rest() {
    this.timeline.stop();
    this.snap(() => {
      this.root.removeAttribute('data-playing');
      this.root.removeAttribute('data-pose');
      delete this.root.dataset.step;
      for (const { el } of this.timed) el.classList.remove('is-on');
    });
  }

  play() {
    if (this.state !== 'waiting' || !this.canPlay() || document.hidden) return;
    this.state = 'playing';
    const steps = this.beats.map((at, index): Beat => [
      at,
      () => {
        if (index === 0) this.root.removeAttribute('data-pose');
        this.showStep(index + 1);
      },
    ]);
    const last = this.beats.at(-1) ?? 0;
    this.timeline.play([...steps, [last + STEP_SETTLE_MS, () => this.finish()]]);
  }

  finish() {
    if (this.state === 'done') return;
    this.state = 'done';
    this.rest();
    this.onDone(this);
  }

  /** Motion must stop: a playing story ends on its final frame; an unseen one shows it for now. */
  hold() {
    if (this.state === 'playing') this.finish();
    else if (this.state === 'waiting') this.rest();
  }

  /** Motion is allowed again: an unseen scene returns to its intro and plays if it is in view. */
  rearm() {
    if (this.state !== 'waiting' || !this.canPlay()) return;
    this.prepare();
    if (this.inBand) this.play();
  }
}

function attachTilt(story: SceneStory, reducedMotion: MediaQueryList) {
  const stack = story.root.querySelector<HTMLElement>('[data-scene-stack]');
  if (!stack || !window.matchMedia(FINE_POINTER_QUERY).matches) return;
  const aim = createPointerFollower((x, y) => {
    stack.style.setProperty('--tilt-x', `${(-y * TILT_DEG.x).toFixed(2)}deg`);
    stack.style.setProperty('--tilt-y', `${(x * TILT_DEG.y).toFixed(2)}deg`);
    stack.style.setProperty('--hot-x', `${(x * 70 + 50).toFixed(1)}%`);
    stack.style.setProperty('--hot-y', `${(y * 70 + 40).toFixed(1)}%`);
  });
  story.root.addEventListener('pointermove', (event) => {
    if (reducedMotion.matches || isMotionPaused()) return;
    const box = story.root.getBoundingClientRect();
    aim((event.clientX - box.left) / box.width - 0.5, (event.clientY - box.top) / box.height - 0.5);
  });
  story.root.addEventListener('pointerleave', () => aim(0, 0));
  onMotionPauseChange((paused) => {
    if (paused) aim(0, 0);
  });
}

export function initScenes(roots: HTMLElement[]) {
  const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY);
  const motionAllowed = () => !reducedMotion.matches && !isMotionPaused();
  const stories = new Map<Element, SceneStory>();

  // Load images once a scene approaches (CSS backgrounds are not lazy by default).
  const nearby = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute('data-near', '');
        nearby.unobserve(entry.target);
      }
    },
    { rootMargin: PRELOAD_MARGIN }
  );
  const start = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const story = stories.get(entry.target);
        if (!story) continue;
        story.inBand = entry.isIntersecting;
        if (story.inBand) story.play();
      }
    },
    { rootMargin: START_BAND }
  );
  // A story never plays out unseen: once its scene is fully off screen, it rests.
  const onScreen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const story = stories.get(entry.target);
      if (story && !entry.isIntersecting && story.state === 'playing') story.finish();
    }
  });
  const retire = (story: SceneStory) => {
    start.unobserve(story.root);
    onScreen.unobserve(story.root);
  };

  for (const root of roots) {
    const story = new SceneStory(root, motionAllowed, retire);
    stories.set(root, story);
    nearby.observe(root);
    start.observe(root);
    onScreen.observe(root);
    attachTilt(story, reducedMotion);
  }

  const each = (run: (story: SceneStory) => void) => {
    for (const story of stories.values()) run(story);
  };
  reducedMotion.addEventListener('change', () =>
    each((story) => (reducedMotion.matches ? story.hold() : story.rearm()))
  );
  onMotionPauseChange((paused) => each((story) => (paused ? story.hold() : story.rearm())));
  // A hidden tab ends running stories; coming back lets unseen ones start.
  document.addEventListener('visibilitychange', () =>
    each((story) => {
      if (!document.hidden) story.rearm();
      else if (story.state === 'playing') story.finish();
    })
  );
}
