/**
 * PROTOTYPE ONLY — the immersive enter/exit animation. Remove before merge to main.
 *
 * Animating height/width/margin made every frame a full layout: the virtualized message list
 * re-measured and re-wrapped its text, and every frosted pane re-blurred at a new size. This
 * changes the layout exactly once and animates only transform and opacity (compositor-only):
 *
 * Enter: pin each piece of chrome where it is (`position: fixed` at its measured rect), which
 *   takes it out of flow, so the conversation pane expands underneath in one layout. Once the
 *   message list has settled at its new size, the pinned chrome slides off screen over it.
 * Exit: unpin the chrome back into its slots (one layout; the pane shrinks), hold it off
 *   screen until the message list settles, then slide it in.
 */
import { setChatSurfacePrototype } from './prototype-state';

const DURATION_MS = 360;
/** Longest the slide waits for the message list to settle after the pane grows. */
const SETTLE_CAP_MS = 220;
const EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
const PINNED = 'data-proto-pinned';

interface ChromePiece {
  selector: string;
  /** Off-screen transform for a piece whose rect is `r`. */
  offscreen: (r: DOMRect) => string;
  /** Whether this piece leaves only when the composer is set to hide. */
  composer?: boolean;
}

const PIECES: ChromePiece[] = [
  { selector: '.sam-void > header', offscreen: (r) => `translate3d(0, ${-(r.bottom + 12)}px, 0)` },
  {
    selector: '[data-testid="session-floating-header"]',
    offscreen: (r) => `translate3d(0, ${-(r.bottom + 12)}px, 0)`,
  },
  {
    selector: '[data-testid="session-tool-rail"]',
    offscreen: (r) => `translate3d(${window.innerWidth - r.left + 12}px, 0, 0)`,
  },
  {
    selector: '[data-testid="session-footer"]',
    offscreen: (r) => `translate3d(0, ${window.innerHeight - r.top + 12}px, 0)`,
    composer: true,
  },
];

interface Pinned {
  el: HTMLElement;
  rect: DOMRect;
  offscreen: string;
}

let pinned: Pinned[] = [];
let running: Animation[] = [];

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function pin(el: HTMLElement, rect: DOMRect) {
  el.setAttribute(PINNED, '');
  Object.assign(el.style, {
    position: 'fixed',
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    zIndex: '40',
    willChange: 'transform, opacity',
  });
}

function unpin(el: HTMLElement) {
  el.removeAttribute(PINNED);
  for (const prop of [
    'position',
    'top',
    'left',
    'right',
    'bottom',
    'height',
    'margin',
    'z-index',
    'will-change',
    'visibility',
    'pointer-events',
  ]) {
    el.style.removeProperty(prop);
  }
  // The tool rail's width is a React-managed inline style; restore the measured value
  // instead of removing it.
  if (el.dataset.testid !== 'session-tool-rail') el.style.removeProperty('width');
}

/**
 * Resolves once the message list has gone a whole frame without scrolling. Growing the pane
 * makes react-virtuoso re-anchor and render more rows on the main thread; doing that before
 * the slide, while the pinned chrome still covers the pane, keeps it out of the animation.
 */
function listSettled(): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now();
    let scrolled = true;
    const onScroll = () => {
      scrolled = true;
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    const check = () => {
      if (!scrolled || performance.now() - started > SETTLE_CAP_MS) {
        document.removeEventListener('scroll', onScroll, { capture: true });
        resolve();
        return;
      }
      scrolled = false;
      requestAnimationFrame(check);
    };
    requestAnimationFrame(() => requestAnimationFrame(check));
  });
}

let generation = 0;

function cancelRunning() {
  for (const animation of running) animation.cancel();
  running = [];
}

export async function enterImmersive(composer: 'hide' | 'keep') {
  cancelRunning();
  const run = ++generation;
  const found = PIECES.filter((piece) => !piece.composer || composer === 'hide')
    .map((piece) => {
      const el = document.querySelector<HTMLElement>(piece.selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { el, rect, offscreen: piece.offscreen(rect) };
    })
    .filter((p): p is Pinned => p !== null);

  // Measure everything before writing anything, so there is one layout, not one per piece.
  pinned = found;
  for (const p of pinned) {
    pin(p.el, p.rect);
    if (p.el.dataset.testid === 'session-tool-rail') p.el.style.width = `${p.rect.width}px`;
  }
  setChatSurfacePrototype({ immersive: true });
  await listSettled();
  if (run !== generation) return;

  const duration = reducedMotion() ? 0 : DURATION_MS;
  running = pinned.map((p) =>
    p.el.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: p.offscreen, opacity: 0 },
      ],
      { duration, easing: EASING, fill: 'forwards' }
    )
  );
  void Promise.all(running.map((a) => a.finished)).then(
    () => {
      for (const p of pinned) {
        p.el.style.visibility = 'hidden';
        p.el.style.pointerEvents = 'none';
      }
    },
    () => undefined
  );
}

export async function exitImmersive() {
  const els = pinned.filter((p) => p.el.isConnected).map((p) => p.el);
  // Layout first, the same order as entering: unpin so the chrome is back in its slots and
  // the pane shrinks now, in one layout, rather than under the chrome after it has landed.
  resetImmersive();
  const run = generation;
  if (els.length === 0 || reducedMotion()) return;

  // Measure every slot before starting any animation, so this is one forced layout. Each
  // piece is held off screen (paused on its first keyframe) while the list settles.
  const moves = els.map((el) => {
    const piece = PIECES.find((candidate) => el.matches(candidate.selector));
    return { el, offscreen: piece ? piece.offscreen(el.getBoundingClientRect()) : 'none' };
  });
  running = moves.map(({ el, offscreen }) => {
    const animation = el.animate(
      [
        { transform: offscreen, opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: DURATION_MS, easing: EASING, fill: 'backwards' }
    );
    animation.pause();
    return animation;
  });
  await listSettled();
  if (run !== generation) return;
  for (const animation of running) animation.play();
}

/** Restores normal layout at once: unpins the chrome and drops the immersive state. */
export function resetImmersive() {
  generation += 1;
  for (const p of pinned) unpin(p.el);
  pinned = [];
  setChatSurfacePrototype({ immersive: false });
  // Cancelled after the unpin, in the same task, so no frame shows the chrome unanimated.
  cancelRunning();
}
