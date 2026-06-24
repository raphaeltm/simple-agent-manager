import { Monitor, Moon, Sun } from 'lucide-react';
import type { FC } from 'react';

import { type Theme, useTheme } from '../contexts/ThemeContext';

interface ThemeOption {
  value: Theme;
  label: string;
  icon: typeof Sun;
}

const THEME_OPTIONS: ThemeOption[] = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
];

/**
 * Shared three-way theme switcher (Dark | Light | System). Self-contained —
 * reads and writes the preference via {@link useTheme}, so host surfaces need no
 * extra props. Horizontal icon + label layout with `role="group"` +
 * `aria-pressed`, visible focus ring, and theme-aware design tokens only.
 */
export const ThemeSwitcher: FC<{ className?: string }> = ({ className }) => {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="group"
      aria-label="Theme"
      className={`flex gap-1 ${className ?? ''}`.trim()}
    >
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-pressed={active}
            aria-label={label}
            className={`flex items-center justify-center gap-1.5 rounded-sm border py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1 focus-visible:ring-offset-bg-canvas ${
              active
                ? 'bg-accent text-fg-on-accent border-accent flex-1 px-2'
                : 'border-border-default text-fg-muted hover:bg-surface-hover hover:text-fg-primary px-2'
            }`}
          >
            <Icon size={14} aria-hidden="true" />
            {active && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
};
