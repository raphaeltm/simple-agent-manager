import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

/** A user theme preference. `system` follows the OS `prefers-color-scheme`. */
export type Theme = 'dark' | 'light' | 'system';

/** The concrete theme actually applied to the DOM (system has been resolved). */
export type ResolvedTheme = 'dark' | 'light';

/** localStorage key the theme preference is persisted under. */
export const THEME_STORAGE_KEY = 'sam-theme';

/** Default preference when nothing valid is stored. Follow the OS by default. */
export const DEFAULT_THEME: Theme = 'system';

/** The media query used to resolve the `system` preference. */
const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';

/** Maps a resolved theme to the `data-ui-theme` attribute the token layer keys off. */
const THEME_ATTRIBUTE: Record<ResolvedTheme, string> = {
  dark: 'sam',
  light: 'sam-light',
};

/** True when the OS currently prefers a dark color scheme. Safe to call before render. */
function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(PREFERS_DARK_QUERY).matches;
  } catch {
    // matchMedia unavailable (very old browser, SSR) — assume dark (product origin).
    return true;
  }
}

/**
 * Resolves a preference to the concrete theme to apply. `system` consults the
 * OS color-scheme media query.
 */
export function resolveEffectiveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') {
    return systemPrefersDark() ? 'dark' : 'light';
  }
  return theme;
}

/**
 * Reads the persisted preference from localStorage, falling back to
 * {@link DEFAULT_THEME}. Backwards compatible: legacy `dark`/`light` values keep
 * working; only an absent or unrecognized value resolves to `system`. Safe to
 * call before render; mirrors the pre-paint logic in main.tsx so the React state
 * and the already-applied DOM attribute agree on first mount.
 */
export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light' || stored === 'system') {
      return stored;
    }
  } catch {
    // localStorage unavailable (private mode, SSR) — fall back to default.
  }
  return DEFAULT_THEME;
}

/** Applies the resolved theme to <html> via the `data-ui-theme` attribute. */
export function applyThemeAttribute(theme: Theme): void {
  const resolved = resolveEffectiveTheme(theme);
  document.documentElement.setAttribute('data-ui-theme', THEME_ATTRIBUTE[resolved]);
}

export interface ThemeContextValue {
  /** The user's stored preference (`dark` | `light` | `system`). */
  theme: Theme;
  /** The concrete theme currently applied (system has been resolved). */
  resolvedTheme: ResolvedTheme;
  /** Convenience: whether the resolved theme is dark. */
  isDark: boolean;
  /** Sets and persists the preference. */
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveEffectiveTheme(readStoredTheme()),
  );

  // Apply the resolved attribute and persist the preference whenever it changes.
  useEffect(() => {
    const resolved = resolveEffectiveTheme(theme);
    setResolvedTheme(resolved);
    document.documentElement.setAttribute('data-ui-theme', THEME_ATTRIBUTE[resolved]);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Persistence is best-effort; ignore storage failures.
    }
  }, [theme]);

  // While following the OS, react live to color-scheme changes (no reload).
  useEffect(() => {
    if (theme !== 'system') return;
    let media: MediaQueryList;
    try {
      media = window.matchMedia(PREFERS_DARK_QUERY);
    } catch {
      return;
    }
    const handleChange = () => {
      const resolved = systemPrefersDark() ? 'dark' : 'light';
      setResolvedTheme(resolved);
      document.documentElement.setAttribute('data-ui-theme', THEME_ATTRIBUTE[resolved]);
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, isDark: resolvedTheme === 'dark', setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
