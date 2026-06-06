import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  ThemeProvider,
  useTheme,
} from '../../src/contexts/ThemeContext';

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
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-ui-theme');
  });

  it('defaults to dark when no preference is stored', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('dark');
    expect(DEFAULT_THEME).toBe('dark');
    expect(result.current.isDark).toBe(true);
    expect(currentAttribute()).toBe('sam');
  });

  it('reads a persisted light preference on mount', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('light');
    expect(result.current.isDark).toBe(false);
    expect(currentAttribute()).toBe('sam-light');
  });

  it('toggleTheme flips the theme, DOM attribute, and localStorage', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    expect(result.current.theme).toBe('dark');

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.theme).toBe('light');
    expect(currentAttribute()).toBe('sam-light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.theme).toBe('dark');
    expect(currentAttribute()).toBe('sam');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('setTheme applies the requested theme explicitly', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setTheme('light');
    });

    expect(result.current.theme).toBe('light');
    expect(currentAttribute()).toBe('sam-light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('useTheme throws when used outside a ThemeProvider', () => {
    expect(() => renderHook(() => useTheme())).toThrow(
      /useTheme must be used within a ThemeProvider/,
    );
  });

  it('toggle button in a consumer flips the theme on click', async () => {
    const user = userEvent.setup();

    function ToggleConsumer() {
      const { isDark, toggleTheme } = useTheme();
      return (
        <button type="button" onClick={toggleTheme}>
          {isDark ? 'Light theme' : 'Dark theme'}
        </button>
      );
    }

    render(
      <ThemeProvider>
        <ToggleConsumer />
      </ThemeProvider>,
    );

    // Starts dark → button offers to switch to light.
    const button = screen.getByRole('button', { name: 'Light theme' });
    expect(currentAttribute()).toBe('sam');

    await user.click(button);

    expect(currentAttribute()).toBe('sam-light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(screen.getByRole('button', { name: 'Dark theme' })).toBeInTheDocument();
  });
});
