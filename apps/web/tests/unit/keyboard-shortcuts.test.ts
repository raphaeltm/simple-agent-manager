import { describe, it, expect } from 'vitest';
import {
  SHORTCUTS,
  formatShortcut,
  matchesShortcut,
  modifierLabel,
  getShortcutsByCategory,
  getShortcut,
} from '../../src/lib/keyboard-shortcuts';

describe('keyboard-shortcuts', () => {
  describe('SHORTCUTS registry', () => {
    it('has no duplicate IDs', () => {
      const ids = SHORTCUTS.map((s) => s.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it('every shortcut has a description', () => {
      for (const s of SHORTCUTS) {
        expect(s.description.length).toBeGreaterThan(0);
      }
    });

    it('every shortcut has a valid category', () => {
      const validCategories = new Set(['Navigation', 'Tabs', 'Sessions', 'General']);
      for (const s of SHORTCUTS) {
        expect(validCategories.has(s.category)).toBe(true);
      }
    });

    it('contains expected navigation shortcuts', () => {
      const navIds = SHORTCUTS.filter((s) => s.category === 'Navigation').map((s) => s.id);
      expect(navIds).toContain('toggle-file-browser');
      expect(navIds).toContain('toggle-git-changes');
      expect(navIds).toContain('focus-chat');
      expect(navIds).toContain('focus-terminal');
    });

    it('contains tab-1 through tab-9', () => {
      for (let i = 1; i <= 9; i++) {
        expect(getShortcut(`tab-${i}`)).toBeDefined();
      }
    });

    it('contains session management shortcuts', () => {
      expect(getShortcut('new-chat')).toBeDefined();
      expect(getShortcut('new-terminal')).toBeDefined();
    });

    it('contains show-shortcuts', () => {
      expect(getShortcut('show-shortcuts')).toBeDefined();
    });
  });

  describe('getShortcutsByCategory', () => {
    it('groups shortcuts by category', () => {
      const grouped = getShortcutsByCategory();
      expect(grouped.has('Navigation')).toBe(true);
      expect(grouped.has('Tabs')).toBe(true);
      expect(grouped.has('Sessions')).toBe(true);
      expect(grouped.has('General')).toBe(true);
    });

    it('each category has at least one shortcut', () => {
      const grouped = getShortcutsByCategory();
      for (const [, shortcuts] of grouped) {
        expect(shortcuts.length).toBeGreaterThan(0);
      }
    });
  });

  describe('modifierLabel', () => {
    // jsdom reports a non-mac platform, so we test the non-mac labels
    it('returns Ctrl for meta on non-mac', () => {
      expect(modifierLabel('meta')).toBe('Ctrl');
    });

    it('returns Shift for shift on non-mac', () => {
      expect(modifierLabel('shift')).toBe('Shift');
    });

    it('returns Alt for alt on non-mac', () => {
      expect(modifierLabel('alt')).toBe('Alt');
    });
  });

  describe('formatShortcut', () => {
    it('formats a meta+shift shortcut with plus separators on non-mac', () => {
      const shortcut = getShortcut('toggle-file-browser')!;
      const formatted = formatShortcut(shortcut);
      expect(formatted).toBe('Ctrl+Shift+E');
    });

    it('formats a meta-only shortcut', () => {
      const shortcut = getShortcut('focus-chat')!;
      const formatted = formatShortcut(shortcut);
      expect(formatted).toBe('Ctrl+/');
    });

    it('formats tab shortcuts with ctrl modifier', () => {
      const shortcut = getShortcut('next-tab')!;
      const formatted = formatShortcut(shortcut);
      expect(formatted).toBe('Ctrl+Tab');
    });
  });

  describe('matchesShortcut', () => {
    function createKeyboardEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
      return {
        key: '',
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        ...overrides,
      } as KeyboardEvent;
    }

    it('matches Ctrl+Shift+E for toggle-file-browser on non-mac', () => {
      const shortcut = getShortcut('toggle-file-browser')!;
      const event = createKeyboardEvent({ key: 'e', ctrlKey: true, shiftKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(true);
    });

    it('does not match without shift', () => {
      const shortcut = getShortcut('toggle-file-browser')!;
      const event = createKeyboardEvent({ key: 'e', ctrlKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(false);
    });

    it('does not match wrong key', () => {
      const shortcut = getShortcut('toggle-file-browser')!;
      const event = createKeyboardEvent({ key: 'g', ctrlKey: true, shiftKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(false);
    });

    it('matches Ctrl+/ for focus-chat on non-mac', () => {
      const shortcut = getShortcut('focus-chat')!;
      const event = createKeyboardEvent({ key: '/', ctrlKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(true);
    });

    it('matches Ctrl+1 for tab-1 on non-mac', () => {
      const shortcut = getShortcut('tab-1')!;
      const event = createKeyboardEvent({ key: '1', ctrlKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(true);
    });

    it('matches Ctrl+Tab for next-tab', () => {
      const shortcut = getShortcut('next-tab')!;
      const event = createKeyboardEvent({ key: 'Tab', ctrlKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(true);
    });

    it('matches Ctrl+Shift+Tab for prev-tab', () => {
      const shortcut = getShortcut('prev-tab')!;
      const event = createKeyboardEvent({ key: 'Tab', ctrlKey: true, shiftKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(true);
    });

    it('does not match when alt is unexpectedly pressed', () => {
      const shortcut = getShortcut('focus-chat')!;
      const event = createKeyboardEvent({ key: '/', ctrlKey: true, altKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(false);
    });
  });
});
