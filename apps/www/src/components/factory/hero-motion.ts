/**
 * Homepage hero motion: the glass node floor, and the stack of real screens over it.
 *
 * On load the stack is exploded with each layer labelled; once it is on screen (and its screens
 * have loaded) it assembles into its tilted pose.
 * While the hero is live the layers float, the stack follows the pointer, and the cards take turns
 * lighting up, each with a matching light on the floor (amber when an agent needs a person, green
 * when work moves on). This runs for more than 5 s, so the hero has a pause control (WCAG 2.2.2);
 * it also stops while the hero is off screen or the tab is hidden. Reduced motion shows the
 * composed stack over a still floor.
 */
import {
  createGlassNodeField,
  type GlassNodeFieldHandle,
  type GlassNodeFieldOptions,
} from '@simple-agent-manager/ui/glass/node-field';

import { createPointerFollower, FINE_POINTER_QUERY, REDUCED_MOTION_QUERY } from '../../lib/motion';

type Layout = 'desktop' | 'phone';
type Beat = 'needs' | 'agent' | 'wf' | 'review';

const PHONE_QUERY = '(max-width: 767px)';

const FIELD_OPTIONS: Record<Layout, GlassNodeFieldOptions> = {
  desktop: { mode: 'floor', seed: 11, density: 0.22, pitch: 58, vanishX: 0.5, horizonY: 0.4, zmax: 2600, focal: 820 },
  phone: { mode: 'floor', seed: 11, density: 0.22, pitch: 56, vanishX: 0.5, horizonY: 0.5, zmax: 2000, focal: 700 },
};

/** Where on the floor (fractions of the field) each beat lights up, and how. */
const BEATS: { beat: Beat; at: readonly [number, number]; light: 'amber' | 'green'; pulses: number }[] = [
  { beat: 'needs', at: [0.32, 0.92], light: 'amber', pulses: 3 },
  { beat: 'agent', at: [0.24, 0.78], light: 'green', pulses: 2 },
  { beat: 'wf', at: [0.74, 0.86], light: 'green', pulses: 3 },
  { beat: 'review', at: [0.68, 0.72], light: 'green', pulses: 4 },
];

const INTRO_HOLD_MS = 1300;
/** Longest the exploded pose waits for the stack's screens to download before assembling anyway. */
const IMAGE_WAIT_MS = 2500;

/** Resolves once enough of the element is on screen for the visitor to see it move. */
function inView(el: HTMLElement | null, ratio = 0.3): Promise<void> {
  if (!el || !('IntersectionObserver' in window)) return Promise.resolve();
  return new Promise((resolve) => {
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting && e.intersectionRatio >= ratio)) return;
        io.disconnect();
        resolve();
      },
      { threshold: [ratio] },
    );
    io.observe(el);
  });
}

/** Resolves once every screen in the stack has decoded (in the active theme), or after the wait. */
function stackImagesReady(stack: HTMLElement | null): Promise<void> {
  if (!stack) return Promise.resolve();
  const urls = [...stack.querySelectorAll<HTMLElement>('.fshot')]
    .map((el) => /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(el).backgroundImage)?.[1])
    .filter((url): url is string => Boolean(url));
  const loads = urls.map((url) => {
    const img = new Image();
    img.src = url;
    return img.decode().catch(() => undefined);
  });
  return Promise.race([
    Promise.all(loads).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, IMAGE_WAIT_MS)),
  ]);
}
const ASSEMBLE_MS = 1900;
const BEAT_MS = 2600;

export function initFactoryHero(hero: HTMLElement) {
  const fieldRoot = hero.querySelector<HTMLElement>('[data-fh-field]');
  const haze = hero.querySelector<HTMLElement>('[data-fh-haze]');
  const stack = hero.querySelector<HTMLElement>('[data-fh-stack]');
  const stage = hero.querySelector<HTMLElement>('[data-fh-stage]');
  const pauseButton = hero.querySelector<HTMLButtonElement>('[data-fh-pause]');
  const reduced = window.matchMedia(REDUCED_MOTION_QUERY);
  const phone = window.matchMedia(PHONE_QUERY);

  let field: GlassNodeFieldHandle | null = null;
  let layout: Layout = phone.matches ? 'phone' : 'desktop';
  let userPaused = false;
  let onScreen = true;
  let beatTimer = 0;
  let beatIndex = 0;
  let introTimers: number[] = [];

  const running = () => !userPaused && onScreen && !document.hidden && !reduced.matches;

  function buildField() {
    if (!fieldRoot) return;
    field?.destroy();
    fieldRoot.replaceChildren();
    field = createGlassNodeField(fieldRoot, FIELD_OPTIONS[layout]);
    if (field.horizon !== null) haze?.style.setProperty('--horizon', `${field.horizon}px`);
    field.start();
    if (!running()) field.pause();
  }

  const nodeAt = ([fx, fy]: readonly [number, number]) =>
    field && fieldRoot ? field.nodeNear(fieldRoot.clientWidth * fx, fieldRoot.clientHeight * fy) : null;

  function playBeat() {
    const step = BEATS[beatIndex % BEATS.length];
    beatIndex += 1;
    if (!step) return;
    stage?.setAttribute('data-beat', step.beat);
    hero.toggleAttribute('data-alert', step.light === 'amber');
    const node = nodeAt(step.at);
    field?.pin(node, step.light);
    field?.burst(node, step.pulses, step.light);
  }

  function startBeats() {
    window.clearInterval(beatTimer);
    if (!running() || hero.dataset.motion !== 'live') return;
    playBeat();
    beatTimer = window.setInterval(playBeat, BEAT_MS);
  }

  function stopBeats() {
    window.clearInterval(beatTimer);
    beatTimer = 0;
  }

  /** Apply the current running state to the floor, the beats and the CSS animations. */
  function sync() {
    const live = running();
    hero.toggleAttribute('data-paused', !live);
    if (live) {
      field?.resume();
      if (!beatTimer) startBeats();
    } else {
      field?.pause();
      stopBeats();
    }
  }

  function intro() {
    introTimers.forEach((t) => window.clearTimeout(t));
    if (reduced.matches) {
      hero.dataset.motion = 'rest';
      stage?.removeAttribute('data-beat');
      return;
    }
    // Jump straight to the exploded pose (no transition), then let it assemble.
    hero.setAttribute('data-motion-snap', '');
    hero.dataset.motion = 'intro';
    void hero.offsetHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => hero.removeAttribute('data-motion-snap')));
    // Hold the exploded pose until the screens have arrived and the stack is on screen, so the
    // visitor sees it assemble (and it never assembles empty).
    void Promise.all([stackImagesReady(stack), inView(stage)]).then(() => {
      introTimers = [
        window.setTimeout(() => {
          hero.dataset.motion = 'assembling';
          if (field && fieldRoot) field.wakeNear(fieldRoot.clientWidth * 0.5, fieldRoot.clientHeight * 0.86, 460, 16);
        }, INTRO_HOLD_MS),
        window.setTimeout(() => {
          hero.dataset.motion = 'live';
          sync();
          startBeats();
        }, INTRO_HOLD_MS + ASSEMBLE_MS),
      ];
    });
  }

  // Pointer tilt: the stack leans toward the pointer, a few degrees at most.
  if (stack && window.matchMedia(FINE_POINTER_QUERY).matches) {
    const follow = createPointerFollower((x, y) => {
      stack.style.setProperty('--ry', `${(x * 10).toFixed(2)}deg`);
      stack.style.setProperty('--rx', `${(-y * 7).toFixed(2)}deg`);
    });
    hero.addEventListener('pointermove', (event) => {
      if (!running()) return;
      const box = hero.getBoundingClientRect();
      follow((event.clientX - box.left) / box.width - 0.5, (event.clientY - box.top) / box.height - 0.5);
    });
    hero.addEventListener('pointerleave', () => follow(0, 0));
  }

  pauseButton?.addEventListener('click', () => {
    userPaused = !userPaused;
    pauseButton.setAttribute('aria-pressed', String(userPaused));
    pauseButton.setAttribute('aria-label', userPaused ? 'Play animation' : 'Pause animation');
    sync();
  });

  new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    sync();
  }).observe(hero);
  document.addEventListener('visibilitychange', sync);

  reduced.addEventListener('change', () => {
    buildField();
    intro();
    sync();
  });
  phone.addEventListener('change', () => {
    layout = phone.matches ? 'phone' : 'desktop';
    buildField();
  });
  // The floor follows the site theme.
  new MutationObserver(() => field?.setTheme('auto')).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  buildField();
  intro();
}
