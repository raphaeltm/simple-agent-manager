/**
 * Homepage hero motion: the glass node floor, the intro (assemble → stream → "needs input" →
 * "task completed"), pointer tilt, and the pause control required by WCAG 2.2.2.
 *
 * The markup's resting state is the final composed frame, so visitors without JavaScript or
 * with `prefers-reduced-motion` see it still. Only timing is simulated; every layer is real UI.
 */
import {
  createGlassNodeField,
  type GlassNodeFieldHandle,
  type GlassNodeFieldOptions,
} from '@simple-agent-manager/ui/glass/node-field';

import {
  type Beat,
  createPointerFollower,
  FINE_POINTER_QUERY,
  parseNumbers,
  REDUCED_MOTION_QUERY,
  setMotionPaused,
  Timeline,
} from '../../lib/motion';

type Layout = 'desktop' | 'phone';

const DESKTOP_QUERY = '(min-width: 700px)';
/** Share of the hero that must be on screen before the intro starts. */
const START_THRESHOLD = 0.25;

/** Floor geometry per layout (tuned in the A2 prototype). */
const FIELD_OPTIONS: Record<Layout, GlassNodeFieldOptions> = {
  desktop: { mode: 'floor', seed: 11, density: 0.2, pitch: 58, vanishX: 0.6, horizonY: 0.44, zmax: 2600, focal: 820 },
  phone: { mode: 'floor', seed: 11, density: 0.2, pitch: 56, vanishX: 0.5, horizonY: 0.53, zmax: 2000, focal: 700 },
};

interface FieldStory {
  /** The hero's own node, as fractions of the field. */
  anchor: readonly [number, number];
  /** A neighbour that asks for input during the intro, as fractions of the field. */
  peer: readonly [number, number];
  /** Radius (CSS px) and count of nodes woken around the anchor as the scene assembles. */
  wake: readonly [number, number];
}

const FIELD_STORY: Record<Layout, FieldStory> = {
  desktop: { anchor: [0.62, 0.9], peer: [0.8, 0.8], wake: [420, 14] },
  phone: { anchor: [0.5, 0.9], peer: [0.78, 0.8], wake: [260, 10] },
};

/** Slides a StreamingWindow's strip through its beats. */
class StreamController {
  private index = 0;
  private readonly strip: HTMLElement | null;
  private readonly offsets: number[];

  constructor(root: HTMLElement | null) {
    this.strip = root?.querySelector<HTMLElement>('[data-sw-strip]') ?? null;
    // The strip's offsets: percent of the strip's height, one per beat.
    this.offsets = parseNumbers(root?.dataset.offsets);
  }

  private place(animate: boolean) {
    if (!this.strip) return;
    this.strip.style.setProperty('--sw-offset', `${this.offsets[this.index] ?? 0}%`);
    if (!animate) {
      this.strip.style.transition = 'none';
      void this.strip.offsetHeight;
      this.strip.style.transition = '';
    }
  }

  reset() {
    this.index = 0;
    this.place(false);
  }

  next() {
    if (this.index >= this.offsets.length - 1) return;
    this.index += 1;
    this.place(true);
  }

  finish() {
    this.index = Math.max(0, this.offsets.length - 1);
    this.place(false);
  }
}

/** Pointer tilt for the stack and parallax for the floor; settles itself, so it is free at rest. */
function attachTilt(hero: HTMLElement, stack: HTMLElement | null, active: () => boolean) {
  if (!window.matchMedia(FINE_POINTER_QUERY).matches) return () => undefined;
  const aim = createPointerFollower((x, y) => {
    stack?.style.setProperty('--rx', `${(-y * 5).toFixed(2)}deg`);
    stack?.style.setProperty('--ry', `${(x * 7).toFixed(2)}deg`);
    stack?.style.setProperty('--mx', `${(x * 60 + 50).toFixed(1)}%`);
    stack?.style.setProperty('--my', `${(y * 60 + 40).toFixed(1)}%`);
    hero.style.setProperty('--px', x.toFixed(3));
    hero.style.setProperty('--py', y.toFixed(3));
  });
  window.addEventListener(
    'pointermove',
    (event) => {
      if (active()) aim(event.clientX / window.innerWidth - 0.5, event.clientY / window.innerHeight - 0.5);
    },
    { passive: true },
  );
  document.documentElement.addEventListener('pointerleave', () => aim(0, 0));
  return () => aim(0, 0);
}

export function initHero(hero: HTMLElement) {
  const fieldRoot = hero.querySelector<HTMLElement>('[data-hero-field]');
  const haze = hero.querySelector<HTMLElement>('[data-hero-haze]');
  const toggle = hero.querySelector<HTMLButtonElement>('[data-hero-toggle]');
  const stack = hero.querySelector<HTMLElement>('[data-hero-stack]');
  const app = hero.querySelector<HTMLElement>('[data-hero-app]');
  const nodesPlane = hero.querySelector<HTMLElement>('[data-hero-nodes]');
  const phoneChip = hero.querySelector<HTMLElement>('[data-hero-phone-chip]');
  const desktopStream = new StreamController(hero.querySelector('[data-streaming-window="desktop"]'));
  const phoneStream = new StreamController(hero.querySelector('[data-streaming-window="phone"]'));
  const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY);
  const desktop = window.matchMedia(DESKTOP_QUERY);
  const timeline = new Timeline();

  let layout: Layout = desktop.matches ? 'desktop' : 'phone';
  let field: GlassNodeFieldHandle | null = null;
  let paused = false;
  let started = false;
  let onScreen = false;

  // Node references go stale when the field rebuilds on resize, so resolve them on use.
  const at = ([fx, fy]: readonly [number, number]) =>
    field && fieldRoot ? field.nodeNear(fieldRoot.clientWidth * fx, fieldRoot.clientHeight * fy) : null;
  const heroNode = () => at(FIELD_STORY[layout].anchor);
  const peerNode = () => at(FIELD_STORY[layout].peer);

  function buildField() {
    field?.destroy();
    field = null;
    if (!fieldRoot) return;
    field = createGlassNodeField(fieldRoot, FIELD_OPTIONS[layout]);
    if (field.horizon !== null) haze?.style.setProperty('--horizon', `${field.horizon}px`);
    field.start();
    if (paused) field.pause();
  }

  /** Suppresses transitions while classes jump, so a reset or pause snaps instead of animating. */
  function snap(change: () => void) {
    hero.setAttribute('data-motion-snap', '');
    change();
    void hero.offsetHeight;
    if (!paused) hero.removeAttribute('data-motion-snap');
  }

  function composeFinal() {
    timeline.stop();
    snap(() => {
      stack?.classList.remove('is-exploded', 'is-posing');
      stack?.setAttribute('data-notify', 'done');
      app?.classList.remove('is-sheened');
      nodesPlane?.classList.remove('is-pulsing');
      phoneChip?.classList.remove('is-hidden');
      hero.removeAttribute('data-alert');
      desktopStream.finish();
      phoneStream.finish();
    });
    field?.pin(heroNode(), 'green');
  }

  function resetIntro() {
    snap(() => {
      stack?.classList.remove('is-posing');
      stack?.classList.add('is-exploded');
      stack?.setAttribute('data-notify', 'none');
      app?.classList.remove('is-sheened');
      nodesPlane?.classList.remove('is-pulsing');
      phoneChip?.classList.add('is-hidden');
      hero.removeAttribute('data-alert');
      desktopStream.reset();
      phoneStream.reset();
    });
  }

  const stream = (controller: StreamController, pulses: number) => {
    controller.next();
    field?.burst(heroNode(), pulses);
  };
  const wake = () => {
    const [fx, fy] = FIELD_STORY[layout].anchor;
    const [radius, count] = FIELD_STORY[layout].wake;
    if (field && fieldRoot) field.wakeNear(fieldRoot.clientWidth * fx, fieldRoot.clientHeight * fy, radius, count);
  };
  const askForInput = () => {
    stack?.setAttribute('data-notify', 'input');
    hero.setAttribute('data-alert', 'input');
    field?.pin(peerNode(), 'amber');
    field?.burst(peerNode(), 2, 'amber');
  };
  const complete = () => {
    stack?.setAttribute('data-notify', 'done');
    hero.removeAttribute('data-alert');
    field?.pin(heroNode(), 'green');
    field?.burst(heroNode(), 4, 'green');
  };

  const BEATS: Record<Layout, readonly Beat[]> = {
    desktop: [
      [1500, () => {
        stack?.classList.add('is-posing');
        stack?.classList.remove('is-exploded');
        wake();
      }],
      [2700, () => app?.classList.add('is-sheened')],
      [2900, () => stream(desktopStream, 1)],
      [3300, () => stack?.classList.remove('is-posing')],
      [3500, () => stream(desktopStream, 1)],
      [4100, () => stream(desktopStream, 1)],
      [4600, () => {
        stream(desktopStream, 2);
        nodesPlane?.classList.add('is-pulsing');
      }],
      [5100, () => desktopStream.next()],
      [5800, askForInput],
      [8000, complete],
    ],
    phone: [
      [600, wake],
      [1100, () => stream(phoneStream, 1)],
      [2300, () => stream(phoneStream, 2)],
      [3300, () => {
        phoneChip?.classList.remove('is-hidden');
        field?.pin(heroNode(), 'green');
      }],
    ],
  };

  function playIntro() {
    started = true;
    resetIntro();
    timeline.play(BEATS[layout]);
  }

  function setPaused(next: boolean) {
    paused = next;
    setMotionPaused(next);
    toggle?.setAttribute('data-paused', String(next));
    const label = toggle?.querySelector('[data-hero-toggle-label]');
    if (label) label.textContent = next ? 'Play animation' : 'Pause animation';
    if (next) {
      composeFinal();
      resetTilt();
      field?.pause();
    } else {
      hero.removeAttribute('data-motion-snap');
      field?.resume();
      playIntro();
    }
  }

  const resetTilt = attachTilt(
    hero,
    stack,
    () => onScreen && !paused && !reducedMotion.matches && layout === 'desktop',
  );

  // The page has taken over from the pre-paint intro state set inline in Hero.astro.
  hero.setAttribute('data-motion', 'live');
  buildField();
  if (reducedMotion.matches) {
    composeFinal();
  } else {
    resetIntro();
    if (toggle) toggle.hidden = false;
  }

  const visibility = new IntersectionObserver(
    ([entry]) => {
      onScreen = Boolean(entry?.isIntersecting);
      if (onScreen && !started && !paused && !reducedMotion.matches) {
        started = true;
        timeline.play(BEATS[layout]);
      }
    },
    { threshold: START_THRESHOLD },
  );
  visibility.observe(hero);

  toggle?.addEventListener('click', () => setPaused(!paused));

  reducedMotion.addEventListener('change', () => {
    if (toggle) toggle.hidden = reducedMotion.matches;
    if (reducedMotion.matches) composeFinal();
  });

  desktop.addEventListener('change', () => {
    layout = desktop.matches ? 'desktop' : 'phone';
    buildField();
    composeFinal();
  });
}
