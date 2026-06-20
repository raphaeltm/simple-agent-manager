/**
 * Focus Mode — three-state collapse model for the desktop sidebars.
 *
 * - `default`: full nav (220px) + full session sidebar (288px)
 * - `focus`:   icon rail nav (56px) + status strip sidebar (64px)
 * - `zen`:     both sidebars collapsed to glowing edge seams (0px); hover to peek
 *
 * The mode is shared across two components that own different sidebars:
 * - AppShell.tsx owns the nav column (hardcoded grid column)
 * - pages/project-chat/index.tsx owns the session sidebar (flex child)
 *
 * Shared via AppShellContext + persisted to localStorage. Desktop-only.
 */

export type FocusMode = 'default' | 'focus' | 'zen';

export const FOCUS_MODE_ORDER: FocusMode[] = ['default', 'focus', 'zen'];

export const FOCUS_MODE_STORAGE_KEY = 'sam:focus-mode';

/** Nav column width (px) for each mode. */
export const NAV_WIDTH_DEFAULT = 220;
export const NAV_WIDTH_FOCUS = 56;

/** Session sidebar width (px) for each mode. */
export const SESSION_WIDTH_DEFAULT = 288;
export const SESSION_WIDTH_FOCUS = 64;

export function isFocusMode(value: unknown): value is FocusMode {
  return value === 'default' || value === 'focus' || value === 'zen';
}

/** Returns the next mode in the cycle default → focus → zen → default. */
export function nextFocusMode(mode: FocusMode): FocusMode {
  const idx = FOCUS_MODE_ORDER.indexOf(mode);
  return FOCUS_MODE_ORDER[(idx + 1) % FOCUS_MODE_ORDER.length] ?? 'default';
}

export function focusModeLabel(mode: FocusMode): string {
  switch (mode) {
    case 'default':
      return 'Default';
    case 'focus':
      return 'Focus';
    case 'zen':
      return 'Zen';
  }
}

/** Nav column width in px for the given mode (zen collapses to a 0-width overlay seam). */
export function navWidthForMode(mode: FocusMode): number {
  switch (mode) {
    case 'default':
      return NAV_WIDTH_DEFAULT;
    case 'focus':
      return NAV_WIDTH_FOCUS;
    case 'zen':
      return 0;
  }
}

/** Session sidebar width in px for the given mode (zen collapses to a 0-width overlay seam). */
export function sessionWidthForMode(mode: FocusMode): number {
  switch (mode) {
    case 'default':
      return SESSION_WIDTH_DEFAULT;
    case 'focus':
      return SESSION_WIDTH_FOCUS;
    case 'zen':
      return 0;
  }
}
