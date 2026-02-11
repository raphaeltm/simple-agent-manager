import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyViewportMetrics,
  computeViewportMetrics,
  startMobileViewportSync,
} from '../../../src/lib/mobile-viewport';

describe('mobile viewport helpers', () => {
  beforeEach(() => {
    const root = document.documentElement;
    root.style.removeProperty('--sam-app-height');
    root.style.removeProperty('--sam-keyboard-offset');
    root.classList.remove('sam-keyboard-open');
  });

  it('computes viewport metrics without keyboard offset', () => {
    const metrics = computeViewportMetrics({
      layoutHeight: 844,
      visualHeight: 844,
      visualOffsetTop: 0,
    });

    expect(metrics).toEqual({
      appHeightPx: '844px',
      keyboardOffsetPx: '0px',
      keyboardOpen: false,
    });
  });

  it('computes keyboard offset when visual viewport shrinks significantly', () => {
    const metrics = computeViewportMetrics({
      layoutHeight: 844,
      visualHeight: 500,
      visualOffsetTop: 0,
    });

    expect(metrics).toEqual({
      appHeightPx: '500px',
      keyboardOffsetPx: '344px',
      keyboardOpen: true,
    });
  });

  it('applies css variables and keyboard-open class', () => {
    const metrics = {
      appHeightPx: '600px',
      keyboardOffsetPx: '220px',
      keyboardOpen: true,
    };

    applyViewportMetrics(document, metrics);

    const root = document.documentElement;
    expect(root.style.getPropertyValue('--sam-app-height')).toBe('600px');
    expect(root.style.getPropertyValue('--sam-keyboard-offset')).toBe('220px');
    expect(root.classList.contains('sam-keyboard-open')).toBe(true);
  });

  it('syncs and updates values from visual viewport listeners', () => {
    const visualViewportListeners = new Map<string, () => void>();
    const windowListeners = new Map<string, () => void>();

    const visualViewport = {
      height: 780,
      offsetTop: 0,
      addEventListener: vi.fn((event: string, cb: () => void) => {
        visualViewportListeners.set(event, cb);
      }),
      removeEventListener: vi.fn((event: string) => {
        visualViewportListeners.delete(event);
      }),
    };

    const mockWindow = {
      innerHeight: 844,
      visualViewport,
      addEventListener: vi.fn((event: string, cb: () => void) => {
        windowListeners.set(event, cb);
      }),
      removeEventListener: vi.fn((event: string) => {
        windowListeners.delete(event);
      }),
    };

    const stop = startMobileViewportSync(mockWindow as unknown as Window, document);

    expect(document.documentElement.style.getPropertyValue('--sam-app-height')).toBe('780px');
    expect(document.documentElement.classList.contains('sam-keyboard-open')).toBe(false);

    visualViewport.height = 520;
    const resize = visualViewportListeners.get('resize');
    if (!resize) {
      throw new Error('missing visual viewport resize listener');
    }
    resize();

    expect(document.documentElement.style.getPropertyValue('--sam-app-height')).toBe('520px');
    expect(document.documentElement.style.getPropertyValue('--sam-keyboard-offset')).toBe('324px');
    expect(document.documentElement.classList.contains('sam-keyboard-open')).toBe(true);

    stop();

    expect(mockWindow.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(visualViewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });
});
