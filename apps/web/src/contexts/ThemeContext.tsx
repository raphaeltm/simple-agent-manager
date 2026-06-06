import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export type Theme = 'dark' | 'light';

/** localStorage key the theme preference is persisted under. */
export const THEME_STORAGE_KEY = 'sam-theme';

/** Default theme when no preference has been stored. Dark is the product default. */
export const DEFAULT_THEME: Theme = 'dark';

/** Maps a logical theme to the `data-ui-theme` attribute value the token layer keys off. */
const THEME_ATTRIBUTE: Record<Theme, string> = {
  dark: 'sam',
  light: 'sam-light',
};

/**
 * Reads the persisted theme from localStorage, falling back to {@link DEFAULT_THEME}.
 * Safe to call before render; mirrors the pre-paint logic in main.tsx so the React
 * state and the already-applied DOM attribute agree on first mount.
 */
export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') {
      return stored;
    }
  } catch {
    // localStorage unavailable (private mode, SSR) — fall back to default.
  }
  return DEFAULT_THEME;
}

/** Applies the theme to <html> via the `data-ui-theme` attribute. */
export function applyThemeAttribute(theme: Theme): void {
  document.documentElement.setAttribute('data-ui-theme', THEME_ATTRIBUTE[theme]);
}

export interface ThemeContextValue {
  theme: Theme;
  isDark: boolean;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());

  // Keep the DOM attribute and localStorage in sync whenever the theme changes.
  useEffect(() => {
    applyThemeAttribute(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Persistence is best-effort; ignore storage failures.
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, isDark: theme === 'dark', setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
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
