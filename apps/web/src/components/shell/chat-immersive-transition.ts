/**
 * The slide into and out of the phone-only immersive chat view (`chat-immersive-context.ts`).
 *
 * The chrome it moves is whatever carries `data-immersive-chrome`: the app bar, the session
 * header, the tool rail and the composer. Animating their height, width or margins makes every
 * frame a full layout: the virtualized message list re-measures and re-wraps its rows, and every
 * frosted pane re-blurs at a new size, which is visibly janky on a phone. So the layout changes
 * once and the slide itself is transform and opacity only:
 *
 * - Enter: pin each piece where it is (`position: fixed` at its measured rect), which takes it
 *   out of flow, and commit the immersive state in the same frame. The conversation expands
 *   underneath in one layout. Once the message list has stopped re-anchoring, the pinned chrome
 *   slides off screen over it.
 * - Exit: unpin the chrome back into its slots and commit the normal state in the same frame
 *   (one layout; the conversation shrinks), hold the chrome off screen until the list settles,
 *   then slide it in. Changing the layout first means nothing jumps when the chrome lands.
 *
 * Module state, because there is one chat surface on a phone and the pinned elements belong to
 * several components (the shell and the chat) that do not share a parent below the shell.
 */
import { flushSync } from 'react-dom';

/** Slide duration. A design constant of the motion, like the easing curve. */
const SLIDE_DURATION_MS = 360;
const SLIDE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
/** Longest the slide waits for the message list to settle after the conversation resizes. */
const SETTLE_CAP_MS = 220;
/** How far past the screen edge a piece travels, so its shadow leaves with it. */
const OFFSCREEN_MARGIN_PX = 12;

/**
 * The `data-immersive-chrome` values: the contract between the transition and the components
 * it moves. Components set the attribute from this map, so a typo is a type error rather than a
 * piece that silently slides off the wrong edge.
 */
export const IMMERSIVE_CHROME = {
  appBar: 'app-bar',
  sessionHeader: 'session-header',
  toolRail: 'tool-rail',
  composer: 'composer',
} as const;
export type ImmersiveChromeName = (typeof IMMERSIVE_CHROME)[keyof typeof IMMERSIVE_CHROME];

const CHROME_SELECTOR = '[data-immersive-chrome]';
const PINNED_ATTR = 'data-immersive-pinned';

/** Which screen edge each piece leaves by. */
type Edge = 'top' | 'right' | 'bottom';
const EDGE_BY_CHROME: Record<ImmersiveChromeName, Edge> = {
  'app-bar': 'top',
  'session-header': 'top',
  'tool-rail': 'right',
  composer: 'bottom',
};

function isChromeName(value: string | undefined): value is ImmersiveChromeName {
  return value !== undefined && value in EDGE_BY_CHROME;
}

/** Inline properties `pin` writes, removed again by `unpin`. */
const PINNED_PROPS = [
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
] as const;

type SetActive = (on: boolean) => void;

export interface ChatImmersiveOptions {
  /**
   * Keeps the conversation on its newest message. Pass it only when the reader is at the newest
   * message when they tap: resizing a virtualized list re-anchors it on its top row, and once the
   * width changes too the rows reflow, so the newest message would otherwise slide out of view.
   */
  stickToBottom?: () => void;
}

interface Pinned {
  el: HTMLElement;
  /** The inline `width` the element had before pinning, restored on unpin. */
  width: string;
}

let pinned: Pinned[] = [];
let running: Animation[] = [];
/** Bumped by every enter/exit/reset, so an awaited settle from an earlier toggle stands down. */
let generation = 0;

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function offscreenTransform(el: HTMLElement, rect: DOMRect): string {
  const name = el.dataset.immersiveChrome;
  const edge = isChromeName(name) ? EDGE_BY_CHROME[name] : 'top';
  if (edge === 'right') {
    return `translate3d(${window.innerWidth - rect.left + OFFSCREEN_MARGIN_PX}px, 0, 0)`;
  }
  if (edge === 'bottom') {
    return `translate3d(0, ${window.innerHeight - rect.top + OFFSCREEN_MARGIN_PX}px, 0)`;
  }
  return `translate3d(0, ${-(rect.bottom + OFFSCREEN_MARGIN_PX)}px, 0)`;
}

function chromeElements(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(CHROME_SELECTOR)).filter(
    // `display: none` (an empty composer) and zero-size pieces have nothing to slide.
    (el) => el.getClientRects().length > 0
  );
}

function pin(el: HTMLElement, rect: DOMRect): Pinned {
  const record = { el, width: el.style.width };
  el.setAttribute(PINNED_ATTR, '');
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
  return record;
}

/**
 * `position: fixed` is relative to the viewport only when no ancestor contains layout, and the
 * shell's `<main>` does (`.sam-main-content { contain: layout }`), so a pinned piece inside it is
 * placed relative to `<main>`, which itself moves once the app bar leaves the flow. Measure where
 * each pinned piece landed in the final layout and move it back onto its original rect. Reads
 * all, then writes all, before the next paint, so nothing visibly jumps.
 */
function correctPins(measured: ReadonlyArray<{ el: HTMLElement; rect: DOMRect }>) {
  const landed = measured.map(({ el }) => el.getBoundingClientRect());
  measured.forEach(({ el, rect }, i) => {
    const at = landed[i];
    if (!at) return;
    el.style.top = `${rect.top + (rect.top - at.top)}px`;
    el.style.left = `${rect.left + (rect.left - at.left)}px`;
  });
}

function unpin({ el, width }: Pinned) {
  el.removeAttribute(PINNED_ATTR);
  for (const prop of PINNED_PROPS) el.style.removeProperty(prop);
  el.style.width = width;
}

/** Pieces held `inert` while they come back in, out of sight or still sliding. */
let inertHeld: HTMLElement[] = [];

function cancelRunning() {
  for (const animation of running) animation.cancel();
  running = [];
  for (const el of inertHeld) el.removeAttribute('inert');
  inertHeld = [];
}

function slide(el: HTMLElement, from: string, to: string, fromOpacity: number, toOpacity: number) {
  return el.animate(
    [
      { transform: from, opacity: fromOpacity },
      { transform: to, opacity: toOpacity },
    ],
    // `both` holds the first frame while paused and the last frame once finished.
    { duration: SLIDE_DURATION_MS, easing: SLIDE_EASING, fill: 'both' }
  );
}

/**
 * Resolves once the message list has gone a whole frame without scrolling. Resizing the
 * conversation makes react-virtuoso re-anchor and render rows on the main thread; letting that
 * finish before the slide keeps it out of the animation's frames.
 */
function listSettled(onFrame?: () => void): Promise<void> {
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
      // Re-pinning to the newest message scrolls only while the list is still moving, so it
      // keeps the wait going exactly as long as the list needs.
      onFrame?.();
      requestAnimationFrame(check);
    };
    // Two frames: the first paints the new layout, the second sees any re-anchoring scroll.
    requestAnimationFrame(() => requestAnimationFrame(check));
  });
}

export async function enterChatImmersive(
  setActive: SetActive,
  { stickToBottom }: ChatImmersiveOptions = {}
): Promise<void> {
  cancelRunning();
  const run = ++generation;

  // Measure every piece before writing anything, so this is one forced layout, not one per piece.
  const measured = chromeElements().map((el) => ({ el, rect: el.getBoundingClientRect() }));
  pinned = measured.map(({ el, rect }) => pin(el, rect));
  flushSync(() => setActive(true));
  correctPins(measured);
  stickToBottom?.();

  const moves = measured.map(({ el, rect }) => ({ el, offscreen: offscreenTransform(el, rect) }));
  if (prefersReducedMotion()) {
    for (const { el } of moves) el.style.visibility = 'hidden';
    await listSettled(stickToBottom);
    return;
  }
  await listSettled(stickToBottom);
  if (run !== generation) return;

  running = moves.map(({ el, offscreen }) => slide(el, 'none', offscreen, 1, 0));
  try {
    await Promise.all(running.map((animation) => animation.finished));
  } catch {
    return; // Cancelled by a newer toggle.
  }
  if (run !== generation) return;
  // Off screen and invisible either way; hidden as well, so nothing pinned can take focus or taps.
  for (const { el } of moves) {
    el.style.visibility = 'hidden';
    el.style.pointerEvents = 'none';
  }
  stickToBottom?.();
}

export async function exitChatImmersive(
  setActive: SetActive,
  { stickToBottom }: ChatImmersiveOptions = {}
): Promise<void> {
  const els = pinned.filter((p) => p.el.isConnected).map((p) => p.el);
  const run = ++generation;
  unpinAll();
  flushSync(() => setActive(false));
  cancelRunning();
  stickToBottom?.();
  if (els.length === 0 || prefersReducedMotion()) {
    await listSettled(stickToBottom);
    return;
  }

  // Measure every slot before starting any animation, so this is one forced layout. Each piece
  // is held off screen on its first keyframe while the list settles.
  const moves = els.map((el) => ({
    el,
    offscreen: offscreenTransform(el, el.getBoundingClientRect()),
  }));
  running = moves.map(({ el, offscreen }) => {
    const animation = slide(el, offscreen, 'none', 0, 1);
    animation.pause();
    return animation;
  });
  // Back in the flow but invisible and off screen until the slide lands: keep them out of the
  // tab order and the accessibility tree meanwhile, so nothing unseen can take focus.
  for (const { el } of moves) el.setAttribute('inert', '');
  inertHeld = moves.map(({ el }) => el);
  await listSettled(stickToBottom);
  if (run !== generation) return;
  for (const animation of running) animation.play();
  try {
    await Promise.all(running.map((animation) => animation.finished));
  } catch {
    return;
  }
  if (run !== generation) return;
  cancelRunning();
  stickToBottom?.();
}

function unpinAll() {
  for (const record of pinned) unpin(record);
  pinned = [];
}

/**
 * Ends the immersive view at once, with no slide: unpins the chrome and clears the state. Safe
 * to call from an effect cleanup (it does not force a synchronous commit).
 */
export function resetChatImmersive(setActive: SetActive): void {
  generation += 1;
  unpinAll();
  setActive(false);
  cancelRunning();
}
