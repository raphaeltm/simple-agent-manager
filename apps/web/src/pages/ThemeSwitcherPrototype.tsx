import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';

type Theme = 'dark' | 'light' | 'system';

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

/* ---------- Shared active/inactive styles ---------- */
const activeClasses = 'bg-accent text-fg-on-accent border-accent';
const inactiveClasses =
  'border-border-default text-fg-muted hover:bg-surface-hover hover:text-fg-primary';
const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1 focus-visible:ring-offset-bg-canvas';

/* =========================================================
   CURRENT — tall vertical icon + label (the one to improve)
   ========================================================= */
function CurrentVariant({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return (
    <div role="group" aria-label="Theme" className="flex gap-1">
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-pressed={active}
            className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-sm border px-1 py-2 text-xs font-medium transition-colors min-h-[44px] ${focusRing} ${active ? activeClasses : inactiveClasses}`}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* =========================================================
   VARIATION A — horizontal icon + label, single row
   ========================================================= */
function VariantA({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return (
    <div role="group" aria-label="Theme" className="flex gap-1">
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-pressed={active}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-sm border px-2 py-1.5 text-xs font-medium transition-colors ${focusRing} ${active ? activeClasses : inactiveClasses}`}
          >
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* =========================================================
   VARIATION B — icon-only with tooltip (most compact)
   ========================================================= */
function VariantB({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return (
    <div role="group" aria-label="Theme" className="flex gap-1">
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-pressed={active}
            aria-label={label}
            title={label}
            className={`flex items-center justify-center rounded-sm border p-2 transition-colors ${focusRing} ${active ? activeClasses : inactiveClasses}`}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

/* =========================================================
   VARIATION C — segmented pill (rounded, tight)
   ========================================================= */
function VariantC({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex rounded-md border border-border-default overflow-hidden"
    >
      {THEME_OPTIONS.map(({ value, label, icon: Icon }, i) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-pressed={active}
            aria-label={label}
            title={label}
            className={`flex items-center justify-center px-2.5 py-1.5 transition-colors ${focusRing} ${
              active
                ? 'bg-accent text-fg-on-accent'
                : 'text-fg-muted hover:bg-surface-hover hover:text-fg-primary'
            } ${i > 0 ? 'border-l border-border-default' : ''}`}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

/* =========================================================
   VARIATION D — inline row, icon-only, with active label shown
   ========================================================= */
function VariantD({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return (
    <div role="group" aria-label="Theme" className="flex items-center gap-1">
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-pressed={active}
            aria-label={label}
            className={`flex items-center gap-1.5 rounded-sm border px-2 py-1.5 text-xs font-medium transition-colors ${focusRing} ${active ? activeClasses : inactiveClasses}`}
          >
            <Icon size={14} aria-hidden="true" />
            {active && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* =========================================================
   VARIATION E — dropdown select style
   ========================================================= */
function VariantE({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const current = THEME_OPTIONS.find((o) => o.value === theme)!;
  const CurrentIcon = current.icon;

  return (
    <div className="relative inline-flex items-center">
      <CurrentIcon
        size={14}
        className="absolute left-2 pointer-events-none text-fg-muted"
        aria-hidden="true"
      />
      <select
        aria-label="Theme"
        value={theme}
        onChange={(e) => setTheme(e.target.value as Theme)}
        className={`appearance-none rounded-sm border border-border-default bg-transparent text-fg-primary text-xs font-medium pl-7 pr-6 py-1.5 cursor-pointer transition-colors hover:bg-surface-hover ${focusRing}`}
      >
        {THEME_OPTIONS.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <svg
        className="absolute right-1.5 pointer-events-none text-fg-muted"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
  );
}

/* =========================================================
   Sidebar mockup wrapper to show context
   ========================================================= */
function SidebarMockup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="w-[260px] rounded-lg border border-border-default bg-bg-canvas overflow-hidden">
      {/* Simulated nav items */}
      <div className="px-3 py-2 space-y-0.5">
        <div className="h-7 rounded-sm bg-surface-hover opacity-30" />
        <div className="h-7 rounded-sm bg-surface-hover opacity-20" />
        <div className="h-7 rounded-sm bg-surface-hover opacity-15" />
      </div>

      {/* Footer area like the real sidebar */}
      <div className="mt-2 border-t border-border-default">
        <div className="px-3 pt-3">
          {children}
        </div>
        <div className="p-3 flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-accent/40 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-fg-primary truncate">
              Raphael Titsworth-...
            </div>
          </div>
          <svg
            width="16"
            height="16"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            className="text-fg-muted"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
            />
          </svg>
        </div>
      </div>

      <div className="px-3 pb-2 text-[10px] text-fg-muted font-mono uppercase tracking-wider">
        {label}
      </div>
    </div>
  );
}

/* =========================================================
   PROTOTYPE PAGE
   ========================================================= */
export function ThemeSwitcherPrototype() {
  const [theme, setTheme] = useState<Theme>('system');

  return (
    <div
      data-ui-theme="sam"
      style={{ height: '100vh', overflow: 'auto' }}
      className="bg-bg-canvas p-6"
    >
      <div className="max-w-4xl mx-auto">
        <h1 className="text-lg font-semibold text-fg-primary mb-1">
          Theme Switcher Variations
        </h1>
        <p className="text-sm text-fg-muted mb-6">
          Comparing space efficiency of theme switcher layouts in the sidebar footer.
        </p>

        <div className="flex flex-wrap gap-6">
          <SidebarMockup label="Current">
            <CurrentVariant theme={theme} setTheme={setTheme} />
          </SidebarMockup>

          <SidebarMockup label="A: Horizontal icon+label">
            <VariantA theme={theme} setTheme={setTheme} />
          </SidebarMockup>

          <SidebarMockup label="B: Icons only">
            <VariantB theme={theme} setTheme={setTheme} />
          </SidebarMockup>

          <SidebarMockup label="C: Segmented pill">
            <VariantC theme={theme} setTheme={setTheme} />
          </SidebarMockup>

          <SidebarMockup label="D: Icon + active label">
            <VariantD theme={theme} setTheme={setTheme} />
          </SidebarMockup>

          <SidebarMockup label="E: Select dropdown">
            <VariantE theme={theme} setTheme={setTheme} />
          </SidebarMockup>
        </div>
      </div>
    </div>
  );
}
