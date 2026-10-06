import { describe, expect, it } from 'vitest';

import {
  FOCUS_MODE_ORDER,
  FOCUS_MODE_STORAGE_KEY,
  type FocusMode,
  focusModeLabel,
  isFocusMode,
  NAV_WIDTH_DEFAULT,
  NAV_WIDTH_FOCUS,
  navWidthForMode,
  nextFocusMode,
  SESSION_WIDTH_DEFAULT,
  SESSION_WIDTH_FOCUS,
  sessionWidthForMode,
} from '../../../src/lib/focus-mode';

describe('focus-mode', () => {
  describe('isFocusMode', () => {
    it('accepts the three valid modes', () => {
      expect(isFocusMode('default')).toBe(true);
      expect(isFocusMode('focus')).toBe(true);
      expect(isFocusMode('zen')).toBe(true);
    });

    it('rejects unknown / malformed values', () => {
      expect(isFocusMode('full')).toBe(false);
      expect(isFocusMode('')).toBe(false);
      expect(isFocusMode(null)).toBe(false);
      expect(isFocusMode(undefined)).toBe(false);
      expect(isFocusMode(0)).toBe(false);
    });
  });

  describe('nextFocusMode', () => {
    it('cycles default → focus → zen → default', () => {
      expect(nextFocusMode('default')).toBe('focus');
      expect(nextFocusMode('focus')).toBe('zen');
      expect(nextFocusMode('zen')).toBe('default');
    });

    it('returns to the start after a full cycle', () => {
      let mode: FocusMode = 'default';
      for (let i = 0; i < FOCUS_MODE_ORDER.length; i++) {
        mode = nextFocusMode(mode);
      }
      expect(mode).toBe('default');
    });
  });

  describe('focusModeLabel', () => {
    it('returns a human label for each mode', () => {
      expect(focusModeLabel('default')).toBe('Default');
      expect(focusModeLabel('focus')).toBe('Focus');
      expect(focusModeLabel('zen')).toBe('Zen');
    });
  });

  describe('navWidthForMode', () => {
    it('returns full / rail / collapsed widths', () => {
      expect(navWidthForMode('default')).toBe(NAV_WIDTH_DEFAULT);
      expect(navWidthForMode('focus')).toBe(NAV_WIDTH_FOCUS);
      expect(navWidthForMode('zen')).toBe(0);
    });
  });

  describe('sessionWidthForMode', () => {
    it('returns full / strip / collapsed widths', () => {
      expect(sessionWidthForMode('default')).toBe(SESSION_WIDTH_DEFAULT);
      expect(sessionWidthForMode('focus')).toBe(SESSION_WIDTH_FOCUS);
      expect(sessionWidthForMode('zen')).toBe(0);
    });
  });

  it('exposes a stable localStorage key', () => {
    expect(FOCUS_MODE_STORAGE_KEY).toBe('sam:focus-mode');
  });
});
