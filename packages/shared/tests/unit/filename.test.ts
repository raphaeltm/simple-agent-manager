import { describe, expect, it } from 'vitest';

import { MAX_SANITIZED_FILENAME_LENGTH, sanitizeFilename } from '../../src/filename';
import { SAFE_FILENAME_REGEX } from '../../src/types';

describe('sanitizeFilename', () => {
  it('replaces characters outside the safe set and keeps the extension', () => {
    expect(sanitizeFilename('CleanShot 2026-11-04 at 12.22.51@2x.png')).toBe(
      'CleanShot_2026-11-04_at_12.22.51_2x.png'
    );
  });

  it('leaves already-safe names unchanged', () => {
    expect(sanitizeFilename('my_file_v1.2-final.tar.gz')).toBe('my_file_v1.2-final.tar.gz');
  });

  it('replaces spaces with underscores and trims surrounding whitespace', () => {
    expect(sanitizeFilename('  my   report final.pdf ')).toBe('my_report_final.pdf');
  });

  it('folds accents and collapses runs of unsafe characters', () => {
    expect(sanitizeFilename('résumé (copy) #2.pdf')).toBe('resume_copy_2.pdf');
    expect(sanitizeFilename('a@@##b.txt')).toBe('a_b.txt');
  });

  it('removes path separators so the result cannot traverse directories', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeFilename('dir\\file.txt')).toBe('dir_file.txt');
  });

  it('falls back when no letters or digits survive', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('.')).toBe('file');
    expect(sanitizeFilename('..')).toBe('file');
    expect(sanitizeFilename('   ')).toBe('file');
    expect(sanitizeFilename('截图')).toBe('file');
  });

  it('shortens long names to the path component limit and keeps the extension', () => {
    const out = sanitizeFilename(`${'a'.repeat(400)}.png`);
    expect(out).toHaveLength(MAX_SANITIZED_FILENAME_LENGTH);
    expect(out.endsWith('.png')).toBe(true);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(255);
  });

  it('bounds names that grow during sanitization', () => {
    // NFKD turns each U+2487 into "(20)", which sanitizes to "_20_": 1 char in, 4 out.
    const out = sanitizeFilename(`${String.fromCodePoint(0x2487).repeat(200)}.txt`);
    expect(out.length).toBeLessThanOrEqual(MAX_SANITIZED_FILENAME_LENGTH);
    expect(out.endsWith('.txt')).toBe(true);
  });

  it('drops an overlong extension rather than keeping it whole', () => {
    const out = sanitizeFilename(`name.${'x'.repeat(300)}`);
    expect(out).toHaveLength(MAX_SANITIZED_FILENAME_LENGTH);
    expect(out.startsWith('name.')).toBe(true);
  });

  it('always returns a name the upload validators accept', () => {
    const inputs = ['CleanShot@2x.png', 'émoji 😀.jpg', 'a/b\\c:d*e?f"g<h>i|j', ' trailing .txt '];
    for (const input of inputs) {
      const out = sanitizeFilename(input);
      expect(SAFE_FILENAME_REGEX.test(out)).toBe(true);
      expect(out).not.toContain(' ');
      expect(['.', '..']).not.toContain(out);
    }
  });
});
