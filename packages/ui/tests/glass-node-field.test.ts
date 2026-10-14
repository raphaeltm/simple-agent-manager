import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGlassNodeField } from '../src/glass/node-field';

/** Minimal 2D context: every drawing call is a spy; gradients accept colour stops. */
function fakeContext() {
  const gradient = { addColorStop: vi.fn() };
  return new Proxy(
    { filter: 'none', canvas: null, createLinearGradient: () => gradient, createRadialGradient: () => gradient },
    {
      get(target: Record<string, unknown>, key: string) {
        if (!(key in target)) target[key] = vi.fn();
        return target[key];
      },
      set(target: Record<string, unknown>, key: string, value: unknown) {
        target[key] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

const observers: { disconnect: ReturnType<typeof vi.fn> }[] = [];
class FakeObserver {
  disconnect = vi.fn();
  observe = vi.fn();
  constructor() {
    observers.push(this);
  }
}

let root: HTMLDivElement;
let raf: ReturnType<typeof vi.fn>;
let caf: ReturnType<typeof vi.fn>;

function setMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduced-motion') ? reduce : false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  observers.length = 0;
  root = document.createElement('div');
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ width: 1440, height: 900 } as DOMRect);
  document.body.appendChild(root);
  raf = vi.fn(() => 1);
  caf = vi.fn();
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', caf);
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.stubGlobal('ResizeObserver', FakeObserver);
  vi.stubGlobal('MutationObserver', FakeObserver);
  setMotion(false);
});

afterEach(() => {
  root.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createGlassNodeField without a 2D context', () => {
  it('returns an inert handle instead of throwing', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const field = createGlassNodeField(root);
    expect(() => {
      field.start();
      field.pin(field.nodeNear(10, 10), 'green');
      field.burst(null);
      field.destroy();
    }).not.toThrow();
    expect(root.querySelectorAll('canvas')).toHaveLength(0);
    expect(raf).not.toHaveBeenCalled();
  });
});

describe('createGlassNodeField with a 2D context', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext() as never);
  });

  it('adds two decorative canvases and removes them on destroy', () => {
    const field = createGlassNodeField(root);
    const canvases = root.querySelectorAll('canvas');
    expect(canvases).toHaveLength(2);
    canvases.forEach((canvas) => expect(canvas.getAttribute('aria-hidden')).toBe('true'));
    field.destroy();
    expect(root.querySelectorAll('canvas')).toHaveLength(0);
    for (const observer of observers) expect(observer.disconnect).toHaveBeenCalled();
  });

  it('animates only after start, and pause/resume stop and restart the loop', () => {
    const field = createGlassNodeField(root);
    expect(raf).not.toHaveBeenCalled();
    field.start();
    expect(raf).toHaveBeenCalledTimes(1);
    field.pause();
    expect(field.paused).toBe(true);
    expect(caf).toHaveBeenCalled();
    field.resume();
    expect(raf).toHaveBeenCalledTimes(2);
    field.destroy();
  });

  it('paints one still frame and never loops under reduced motion', () => {
    setMotion(true);
    const field = createGlassNodeField(root);
    field.start();
    field.pin(field.nodeNear(1440 * 0.6, 900 * 0.9), 'amber');
    expect(raf).not.toHaveBeenCalled();
    field.destroy();
  });

  it('keeps defaults when options are explicitly undefined', () => {
    const field = createGlassNodeField(root, { pitch: undefined, horizonY: undefined, mode: undefined });
    expect(field.horizon).toBeCloseTo(900 * 0.44);
    expect(field.nodeNear(1440 * 0.6, 900 * 0.9)).not.toBeNull();
    field.destroy();
  });

  it('has no horizon in flat mode', () => {
    const field = createGlassNodeField(root, { mode: 'flat', pitch: 88 });
    expect(field.horizon).toBeNull();
    field.destroy();
  });
});
