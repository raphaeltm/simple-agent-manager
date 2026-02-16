/**
 * Keyboard shortcut definitions for the workspace UI.
 *
 * Each shortcut declares a key combo, human-readable description, and category.
 * The `meta` modifier means Cmd on macOS and Ctrl on Windows/Linux.
 */

export interface ShortcutModifiers {
  meta?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

export interface ShortcutDefinition {
  id: string;
  key: string;
  modifiers: ShortcutModifiers;
  description: string;
  category: 'Navigation' | 'Tabs' | 'Sessions' | 'General';
}

/** Detect macOS once at module load */
const IS_MAC =
  typeof navigator !== 'undefined' &&
  /mac/i.test(navigator.platform ?? navigator.userAgent ?? '');

/**
 * Returns the platform-appropriate modifier symbol.
 * - macOS: ⌘ for meta, ⌃ for ctrl, ⌥ for alt, ⇧ for shift
 * - Other: Ctrl for meta, Ctrl for ctrl, Alt for alt, Shift for shift
 */
export function modifierLabel(mod: keyof ShortcutModifiers): string {
  if (IS_MAC) {
    switch (mod) {
      case 'meta':
        return '\u2318';
      case 'ctrl':
        return '\u2303';
      case 'alt':
        return '\u2325';
      case 'shift':
        return '\u21E7';
    }
  }
  switch (mod) {
    case 'meta':
      return 'Ctrl';
    case 'ctrl':
      return 'Ctrl';
    case 'alt':
      return 'Alt';
    case 'shift':
      return 'Shift';
  }
}

/** Format a shortcut for display (e.g. "⌘⇧E" on Mac, "Ctrl+Shift+E" on others). */
export function formatShortcut(shortcut: ShortcutDefinition): string {
  const parts: string[] = [];
  if (shortcut.modifiers.ctrl) parts.push(modifierLabel('ctrl'));
  if (shortcut.modifiers.meta) parts.push(modifierLabel('meta'));
  if (shortcut.modifiers.alt) parts.push(modifierLabel('alt'));
  if (shortcut.modifiers.shift) parts.push(modifierLabel('shift'));

  let keyLabel = shortcut.key;
  if (keyLabel === '`') keyLabel = '`';
  else if (keyLabel === '/') keyLabel = '/';
  else if (keyLabel === 'Tab') keyLabel = IS_MAC ? '\u21E5' : 'Tab';
  else keyLabel = keyLabel.toUpperCase();

  parts.push(keyLabel);
  return IS_MAC ? parts.join('') : parts.join('+');
}

/** Check if the platform modifier (Cmd on Mac, Ctrl elsewhere) is pressed. */
export function isPlatformMeta(e: KeyboardEvent): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

/** Whether we're on macOS (for display purposes). */
export function isMacPlatform(): boolean {
  return IS_MAC;
}

// ─── Shortcut Registry ───

export const SHORTCUTS: ShortcutDefinition[] = [
  // Navigation
  {
    id: 'toggle-file-browser',
    key: 'e',
    modifiers: { meta: true, shift: true },
    description: 'Toggle file browser',
    category: 'Navigation',
  },
  {
    id: 'toggle-git-changes',
    key: 'g',
    modifiers: { meta: true, shift: true },
    description: 'Toggle git changes',
    category: 'Navigation',
  },
  {
    id: 'focus-chat',
    key: '/',
    modifiers: { meta: true },
    description: 'Focus chat input',
    category: 'Navigation',
  },
  {
    id: 'focus-terminal',
    key: '`',
    modifiers: { meta: true },
    description: 'Focus terminal',
    category: 'Navigation',
  },

  // Tabs
  {
    id: 'next-tab',
    key: 'Tab',
    modifiers: { ctrl: true },
    description: 'Next tab',
    category: 'Tabs',
  },
  {
    id: 'prev-tab',
    key: 'Tab',
    modifiers: { ctrl: true, shift: true },
    description: 'Previous tab',
    category: 'Tabs',
  },
  // Tab 1-9 generated below
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `tab-${i + 1}`,
    key: String(i + 1),
    modifiers: { meta: true } as ShortcutModifiers,
    description: `Switch to tab ${i + 1}`,
    category: 'Tabs' as const,
  })),

  // Sessions
  {
    id: 'new-chat',
    key: 'n',
    modifiers: { meta: true, shift: true },
    description: 'New chat session',
    category: 'Sessions',
  },
  {
    id: 'new-terminal',
    key: 't',
    modifiers: { meta: true, shift: true },
    description: 'New terminal tab',
    category: 'Sessions',
  },

  // General
  {
    id: 'show-shortcuts',
    key: '/',
    modifiers: { meta: true, shift: true },
    description: 'Show keyboard shortcuts',
    category: 'General',
  },
];

/** Look up a shortcut by ID. */
export function getShortcut(id: string): ShortcutDefinition | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

/** Get all shortcuts grouped by category. */
export function getShortcutsByCategory(): Map<string, ShortcutDefinition[]> {
  const map = new Map<string, ShortcutDefinition[]>();
  for (const s of SHORTCUTS) {
    const group = map.get(s.category) ?? [];
    group.push(s);
    map.set(s.category, group);
  }
  return map;
}

/**
 * Check if a keyboard event matches a shortcut definition.
 * `meta` in the definition maps to Cmd on Mac, Ctrl elsewhere.
 *
 * On macOS: `meta` → metaKey, `ctrl` → ctrlKey (independent physical keys).
 * On non-Mac: `meta` and `ctrl` both map to ctrlKey. A shortcut wanting either
 * `meta` or `ctrl` (but not both) requires ctrlKey to be pressed. A shortcut
 * wanting neither requires ctrlKey to be false.
 */
export function matchesShortcut(e: KeyboardEvent, shortcut: ShortcutDefinition): boolean {
  // Check key (case-insensitive for letters)
  if (e.key.toLowerCase() !== shortcut.key.toLowerCase() && e.key !== shortcut.key) {
    return false;
  }

  const wantsMeta = shortcut.modifiers.meta ?? false;
  const wantsCtrl = shortcut.modifiers.ctrl ?? false;
  const wantsShift = shortcut.modifiers.shift ?? false;
  const wantsAlt = shortcut.modifiers.alt ?? false;

  if (IS_MAC) {
    // macOS: metaKey (⌘) and ctrlKey (⌃) are independent
    if (wantsMeta !== e.metaKey) return false;
    if (wantsCtrl !== e.ctrlKey) return false;
  } else {
    // Non-Mac: both meta and ctrl map to ctrlKey
    const wantsCtrlKey = wantsMeta || wantsCtrl;
    if (wantsCtrlKey !== e.ctrlKey) return false;
    // metaKey (Windows key) should not be pressed
    if (e.metaKey) return false;
  }

  if (wantsShift !== e.shiftKey) return false;
  if (wantsAlt !== e.altKey) return false;

  return true;
}
