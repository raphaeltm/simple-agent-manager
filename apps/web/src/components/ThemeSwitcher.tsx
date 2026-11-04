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
 * extra props. A SAM Glass well: the chosen theme is raised with its label,
 * the others show their icon. `role="group"` + `aria-pressed`.
 */
export const ThemeSwitcher: FC<{ className?: string }> = ({ className }) => {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="group"
      aria-label="Theme"
      className={`sam-well flex gap-0.5 rounded-[var(--sam-radius-control)] p-0.5 ${className ?? ''}`.trim()}
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
            className={`flex h-8 items-center justify-center gap-1.5 rounded-[9px] border-0 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
              active
                ? 'sam-raised flex-1 px-2 font-medium text-fg-primary'
                : 'bg-transparent px-2.5 text-fg-muted hover:text-fg-primary'
            }`}
          >
            <Icon size={15} strokeWidth={1.75} aria-hidden="true" className={active ? 'text-[var(--sam-status-success-fg)]' : undefined} />
            {active && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
};
