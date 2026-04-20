import { describe, expect, test } from 'vitest';

import { maskCredential } from '../../../src/lib/credential-mask';

describe('maskCredential', () => {
  describe('short-credential guard (length <= 8)', () => {
    test('returns "...[set]" for null input', () => {
      expect(maskCredential(null)).toBe('...[set]');
    });

    test('returns "...[set]" for undefined input', () => {
      expect(maskCredential(undefined)).toBe('...[set]');
    });

    test('returns "...[set]" for empty string', () => {
      expect(maskCredential('')).toBe('...[set]');
    });

    test('returns "...[set]" for 1-character credential', () => {
      expect(maskCredential('a')).toBe('...[set]');
    });

    test('returns "...[set]" for 4-character credential (no leak of full value)', () => {
      expect(maskCredential('abcd')).toBe('...[set]');
    });

    test('returns "...[set]" for 8-character credential (boundary)', () => {
      expect(maskCredential('12345678')).toBe('...[set]');
    });
  });

  describe('long-credential last-4 path (length > 8)', () => {
    test('returns "...last4" for 9-character credential (boundary)', () => {
      expect(maskCredential('123456789')).toBe('...6789');
    });

    test('returns "...last4" for realistic API key length', () => {
      const apiKey = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
      expect(maskCredential(apiKey)).toBe('...6789');
    });

    test('never echoes more than the last 4 characters for long credentials', () => {
      const secret = 'supersecretkey-ZZZZlast';
      const masked = maskCredential(secret);
      expect(masked).toBe('...last');
      expect(masked).not.toContain('supersecret');
    });
  });

  describe('regression guard — short-credential values must never leak in full', () => {
    test('does NOT return the plaintext of a 3-char credential (slice(-4) leak)', () => {
      // If this test fails, someone reverted to `...${plaintext.slice(-4)}`
      const shortSecret = 'abc';
      const masked = maskCredential(shortSecret);
      expect(masked).not.toContain('abc');
      expect(masked).toBe('...[set]');
    });

    test('does NOT return the plaintext of a 5-char credential', () => {
      const shortSecret = 'abcde';
      const masked = maskCredential(shortSecret);
      expect(masked).not.toContain('abcde');
      expect(masked).toBe('...[set]');
    });
  });
});
