import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  ThemeProvider,
  useTheme,
} from '../../src/contexts/ThemeContext';

/**
 * Minimal controllable `matchMedia` mock. jsdom does not implement matchMedia,
 * so we install one that tracks `change` listeners and lets a test flip the OS
 * preference and dispatch the event, mirroring a real OS theme change.
 */
function installMatchMedia(initialPrefersDark: boolean) {
  let prefersDark = initialPrefersDark;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();

  const mql: MediaQueryList = {
    get matches() {
      return prefersDark;
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, cb: EventListenerOrEventListenerObject) => {
      listeners.add(cb as (e: MediaQueryListEvent) => void);
    },
    removeEventListener: (_type: string, cb: EventListenerOrEventListenerObject) => {
      listeners.delete(cb as (e: MediaQueryListEvent) => void);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };

  window.matchMedia = vi.fn().mockReturnValue(mql);

  return {
    setPrefersDark(next: boolean) {
      prefersDark = next;
      const event = { matches: next } as MediaQueryListEvent;
      for (const cb of listeners) cb(event);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

function currentAttribute(): string | null {
  return document.documentElement.getAttribute('data-ui-theme');
}

describe('ThemeProvider / useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-ui-theme');
    installMatchMedia(true); // default: OS prefers dark
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-ui-theme');
    vi.restoreAllMocks();
  });

  it('defaults to system when no preference is stored', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('system');
    expect(DEFAULT_THEME).toBe('system');
  });

  it('resolves system to dark when the OS prefers dark', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('system');
    expect(result.current.resolvedTheme).toBe('dark');
    expect(result.current.isDark).toBe(true);
    expect(currentAttribute()).toBe('sam');
  });

  it('resolves system to light when the OS prefers light', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('system');
    expect(result.current.resolvedTheme).toBe('light');
    expect(result.current.isDark).toBe(false);
    expect(currentAttribute()).toBe('sam-light');
  });

  it('reacts live to an OS color-scheme change while following system', () => {
    const media = installMatchMedia(true);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(currentAttribute()).toBe('sam');

    act(() => {
      media.setPrefersDark(false);
    });

    expect(result.current.resolvedTheme).toBe('light');
    expect(result.current.isDark).toBe(false);
    expect(currentAttribute()).toBe('sam-light');
  });

  it('does not react to OS changes once an explicit theme is set', () => {
    const media = installMatchMedia(true);
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setTheme('light');
    });
    expect(currentAttribute()).toBe('sam-light');

    // OS flips to dark — explicit light must stay.
    act(() => {
      media.setPrefersDark(true);
    });
    expect(result.current.resolvedTheme).toBe('light');
    expect(currentAttribute()).toBe('sam-light');
  });

  it('reads a persisted legacy light preference on mount', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('light');
    expect(result.current.isDark).toBe(false);
    expect(currentAttribute()).toBe('sam-light');
  });

  it('reads a persisted legacy dark preference on mount', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('dark');
    expect(result.current.isDark).toBe(true);
    expect(currentAttribute()).toBe('sam');
  });

  it('falls back to system for an unrecognized stored value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'lavender');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('system');
  });

  it('setTheme applies, resolves, and persists each preference', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setTheme('light');
    });
    expect(result.current.theme).toBe('light');
    expect(currentAttribute()).toBe('sam-light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    act(() => {
      result.current.setTheme('dark');
    });
    expect(result.current.theme).toBe('dark');
    expect(currentAttribute()).toBe('sam');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    act(() => {
      result.current.setTheme('system');
    });
    expect(result.current.theme).toBe('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    // OS prefers dark in this suite → resolves to sam.
    expect(currentAttribute()).toBe('sam');
  });

  it('removes the media listener when leaving system mode', () => {
    const media = installMatchMedia(true);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(media.listenerCount).toBe(1);

    act(() => {
      result.current.setTheme('dark');
    });
    expect(media.listenerCount).toBe(0);
  });

  it('re-subscribes to the OS preference when returning to system mode', () => {
    const media = installMatchMedia(true);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(media.listenerCount).toBe(1);

    // Leave system mode for an explicit preference — listener detaches.
    act(() => {
      result.current.setTheme('dark');
    });
    expect(media.listenerCount).toBe(0);
    expect(currentAttribute()).toBe('sam');

    // Return to system mode — exactly one listener must be re-attached
    // (no leaks from the previous subscription).
    act(() => {
      result.current.setTheme('system');
    });
    expect(media.listenerCount).toBe(1);
    expect(result.current.resolvedTheme).toBe('dark'); // OS still prefers dark

    // A live OS change after re-subscribing must update the resolved theme.
    act(() => {
      media.setPrefersDark(false);
    });
    expect(result.current.resolvedTheme).toBe('light');
    expect(result.current.isDark).toBe(false);
    expect(currentAttribute()).toBe('sam-light');
  });

  it('useTheme throws when used outside a ThemeProvider', () => {
    expect(() => renderHook(() => useTheme())).toThrow(
      /useTheme must be used within a ThemeProvider/,
    );
  });

  it('a consumer can switch the theme and the DOM attribute updates', async () => {
    const user = userEvent.setup();

    function Consumer() {
      const { setTheme } = useTheme();
      return (
        <button type="button" onClick={() => setTheme('light')}>
          Light
        </button>
      );
    }

    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );

    expect(currentAttribute()).toBe('sam'); // system → dark
    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(currentAttribute()).toBe('sam-light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
});
