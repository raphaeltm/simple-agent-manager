/**
 * Motion and small interactions for the brand guide (/brand/).
 *
 * The markup is the final frame. This script only adds `html.bg-motion` (when motion is
 * allowed) and then animates toward that frame:
 *   [data-reveal], .bg-words   gain `.is-in` once on screen
 *   [data-progress]            get `--p` (0 to 1): `through` = entering to leaving the viewport,
 *                              `pin` = a tall section's sticky child, top-at-top to bottom-at-bottom
 *   [data-pin-track]           a horizontal track driven by its pinned section's `--p`
 * Every motion is scroll-linked or ends within a few seconds, so nothing plays on its own for
 * longer than WCAG 2.2.2's 5 s. Interactions (copy, weight slider, clear-space guides, easing
 * replay, the section rail) work with or without motion.
 */
import { createPointerFollower, FINE_POINTER_QUERY, REDUCED_MOTION_QUERY } from '../../lib/motion';

const root = document.documentElement;
const reduced = window.matchMedia(REDUCED_MOTION_QUERY);
const WIDE_TRACK_QUERY = window.matchMedia('(min-width: 900px)');

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

/* --- Reveals ------------------------------------------------------------------------- */

function revealObserver(threshold: number, rootMargin: string) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      }
    },
    { threshold, rootMargin }
  );
  return observer;
}

function setupReveals() {
  const rise = revealObserver(0.12, '0px 0px -6% 0px');
  // A wipe starts clipped to nothing, and the observer measures the clipped box, so its ratio
  // stays near 0: use threshold 0 and require the box to be 12% of the screen inside instead.
  const wipe = revealObserver(0, '0px 0px -12% 0px');
  document.querySelectorAll<HTMLElement>('[data-reveal], .bg-words').forEach((el) => {
    (el.dataset.reveal === 'wipe' ? wipe : rise).observe(el);
  });
}

/* --- Scroll progress ------------------------------------------------------------------ */

const visible = new Set<HTMLElement>();
let frame = 0;

function progressOf(el: HTMLElement, viewport: number) {
  const rect = el.getBoundingClientRect();
  if (el.dataset.progress === 'leave') {
    // 0 while the element's top is at the top of the screen, 1 once it has scrolled away.
    return rect.height > 0 ? clamp01(-rect.top / rect.height) : 0;
  }
  if (el.dataset.progress === 'pin') {
    const travel = rect.height - viewport;
    return travel > 0 ? clamp01(-rect.top / travel) : 0;
  }
  return clamp01((viewport - rect.top) / (viewport + rect.height));
}

function writeProgress() {
  frame = 0;
  const viewport = window.innerHeight;
  for (const el of visible) el.style.setProperty('--p', progressOf(el, viewport).toFixed(4));
  const doc = document.scrollingElement ?? root;
  const max = doc.scrollHeight - viewport;
  root.style.setProperty('--bg-page-p', (max > 0 ? clamp01(doc.scrollTop / max) : 0).toFixed(4));
}

const requestProgress = () => {
  frame ||= requestAnimationFrame(writeProgress);
};

function setupProgress() {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      if (entry.isIntersecting) visible.add(el);
      else visible.delete(el);
    }
    requestProgress();
  });
  document.querySelectorAll<HTMLElement>('[data-progress]').forEach((el) => observer.observe(el));
  window.addEventListener('scroll', requestProgress, { passive: true });
  window.addEventListener('resize', requestProgress);
}

/* --- Pinned horizontal track (colour) --------------------------------------------------- */

function setupPinTracks() {
  const pins = [...document.querySelectorAll<HTMLElement>('[data-pin]')];
  const layout = () => {
    for (const pin of pins) {
      const track = pin.querySelector<HTMLElement>('[data-pin-track]');
      if (!track) continue;
      const active = WIDE_TRACK_QUERY.matches && root.classList.contains('bg-motion');
      pin.toggleAttribute('data-pinned', active);
      if (!active) {
        pin.style.removeProperty('height');
        continue;
      }
      // The track is as wide as its cards; the pinned frame is as wide as the viewport.
      const frame = track.parentElement ?? pin;
      const shift = Math.max(0, track.scrollWidth - frame.clientWidth);
      pin.style.setProperty('--shift', String(shift));
      pin.style.height = `${shift + window.innerHeight}px`;
    }
    requestProgress();
  };

  // Keyboard users tab into cards that sit off to the side: scroll the page to where the
  // track shows that card, because a transformed track cannot scroll itself into view.
  for (const pin of pins) {
    pin.addEventListener('focusin', (event) => {
      if (!pin.hasAttribute('data-pinned')) return;
      const track = pin.querySelector<HTMLElement>('[data-pin-track]');
      const card = (event.target as HTMLElement).closest<HTMLElement>('[data-pin-card]');
      const shift = Number(pin.style.getPropertyValue('--shift'));
      if (!track || !card || !shift) return;
      const frameWidth = track.parentElement?.clientWidth ?? window.innerWidth;
      const want = clamp01((card.offsetLeft - frameWidth / 2 + card.clientWidth / 2) / shift);
      const top = pin.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({
        top: top + want * (pin.offsetHeight - window.innerHeight),
        behavior: 'instant',
      });
    });
  }

  layout();
  window.addEventListener('resize', layout);
  WIDE_TRACK_QUERY.addEventListener('change', layout);
  document.fonts?.ready.then(layout);
  return layout;
}

/* --- Hero tilt ------------------------------------------------------------------------- */

function setupTilt() {
  const stage = document.querySelector<HTMLElement>('[data-tilt]');
  if (!stage || !window.matchMedia(FINE_POINTER_QUERY).matches) return;
  const follow = createPointerFollower((x, y) => {
    stage.style.setProperty('--tx', x.toFixed(4));
    stage.style.setProperty('--ty', y.toFixed(4));
  }, 0.08);
  window.addEventListener(
    'pointermove',
    (event) =>
      follow(event.clientX / window.innerWidth - 0.5, event.clientY / window.innerHeight - 0.5),
    { passive: true }
  );
  document.documentElement.addEventListener('pointerleave', () => follow(0, 0));
}

/* --- Interactions (always on) --------------------------------------------------------- */

function setupCopy() {
  const status = document.querySelector<HTMLElement>('[data-copy-status]');
  document.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-copy]');
    if (!button) return;
    const value = button.dataset.copy ?? '';
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      if (status) status.textContent = `Could not copy. Select ${value} and copy it.`;
      return;
    }
    button.setAttribute('data-copied', '');
    if (status) status.textContent = `Copied ${value}`;
    window.setTimeout(() => button.removeAttribute('data-copied'), 1600);
  });
}

function setupWeight() {
  document.querySelectorAll<HTMLInputElement>('[data-weight-input]').forEach((input) => {
    const target = document.getElementById(input.dataset.weightInput ?? '');
    const output = document.querySelector<HTMLOutputElement>(`output[for="${input.id}"]`);
    const apply = () => {
      target?.style.setProperty('--wght', input.value);
      if (output) output.value = input.value;
    };
    input.addEventListener('input', () => {
      target?.setAttribute('data-manual', '');
      apply();
    });
    apply();
  });
}

function setupToggles() {
  document.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((button) => {
    const target = document.getElementById(button.dataset.toggle ?? '');
    button.addEventListener('click', () => {
      const on = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(on));
      target?.toggleAttribute('data-on', on);
    });
  });
}

function setupEasings() {
  const demo = document.querySelector<HTMLElement>('[data-easing-demo]');
  if (!demo) return;
  const play = () => {
    demo.removeAttribute('data-playing');
    void demo.offsetWidth;
    demo.setAttribute('data-playing', '');
  };
  demo.querySelector('[data-easing-replay]')?.addEventListener('click', play);
  if (reduced.matches) {
    demo.setAttribute('data-playing', '');
    return;
  }
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      play();
      observer.disconnect();
    },
    // The demo is taller than a phone screen, so wait for it to fill the lower screen instead.
    { threshold: 0, rootMargin: '0px 0px -35% 0px' }
  );
  observer.observe(demo);
}

function setupRail() {
  const links = new Map<string, HTMLAnchorElement>();
  document.querySelectorAll<HTMLAnchorElement>('[data-rail] a[href^="#"]').forEach((link) => {
    links.set(link.hash.slice(1), link);
  });
  if (!links.size) return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const [id, link] of links) {
          if (id === entry.target.id) link.setAttribute('aria-current', 'true');
          else link.removeAttribute('aria-current');
        }
      }
    },
    { rootMargin: '-45% 0px -50% 0px' }
  );
  for (const id of links.keys()) {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  }
}

/* --- Boot ------------------------------------------------------------------------------ */

setupCopy();
setupWeight();
setupToggles();
setupEasings();
setupRail();

if (!reduced.matches) {
  root.classList.add('bg-motion');
  setupReveals();
  setupProgress();
  setupTilt();
}
const relayoutTracks = setupPinTracks();

reduced.addEventListener('change', () => {
  // Turning reduced motion on mid-visit shows every final frame at once.
  if (reduced.matches) {
    root.classList.remove('bg-motion');
    relayoutTracks();
  }
});
