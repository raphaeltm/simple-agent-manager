import { describe, expect, it } from 'vitest';

import { sanitizeFilename } from '../../src/filename';
import { SAFE_FILENAME_REGEX } from '../../src/types';

describe('sanitizeFilename', () => {
  it('replaces characters outside the safe set and keeps the extension', () => {
    expect(sanitizeFilename('CleanShot 2026-11-04 at 12.22.51@2x.png')).toBe(
      'CleanShot 2026-11-04 at 12.22.51_2x.png'
    );
  });

  it('leaves already-safe names unchanged', () => {
    expect(sanitizeFilename('my file_v1.2-final.tar.gz')).toBe('my file_v1.2-final.tar.gz');
  });

  it('folds accents and collapses runs of unsafe characters', () => {
    expect(sanitizeFilename('résumé (copy) #2.pdf')).toBe('resume _copy_ _2.pdf');
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
    expect(sanitizeFilename('截图', 'upload')).toBe('upload');
  });

  it('always returns a name the upload validators accept', () => {
    const inputs = ['CleanShot@2x.png', 'émoji 😀.jpg', 'a/b\\c:d*e?f"g<h>i|j', ' trailing .txt '];
    for (const input of inputs) {
      const out = sanitizeFilename(input);
      expect(SAFE_FILENAME_REGEX.test(out)).toBe(true);
      expect(['.', '..']).not.toContain(out);
    }
  });
});
