import { buildLibraryR2Key, LIBRARY_DEFAULTS, LIBRARY_FILENAME_PATTERN, LIBRARY_TAG_PATTERN } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/index';
import { validateFilename, validateTag } from '../../../src/services/file-library';

describe('file-library contracts', () => {
  describe('buildLibraryR2Key', () => {
    it('constructs the correct R2 key pattern', () => {
      const key = buildLibraryR2Key('proj-123', 'file-456', 'report.pdf');
      expect(key).toBe('library/proj-123/file-456/report.pdf');
    });

    it('handles filenames with spaces', () => {
      const key = buildLibraryR2Key('p1', 'f1', 'my document.txt');
      expect(key).toBe('library/p1/f1/my document.txt');
    });

    it('preserves exact projectId and fileId in path', () => {
      const projectId = '01HXYZ123456';
      const fileId = '01HABCDEFGH';
      const key = buildLibraryR2Key(projectId, fileId, 'test.txt');
      expect(key).toContain(projectId);
      expect(key).toContain(fileId);
      expect(key.startsWith('library/')).toBe(true);
    });
  });

  describe('LIBRARY_DEFAULTS', () => {
    it('has expected default values', () => {
      expect(LIBRARY_DEFAULTS.UPLOAD_MAX_BYTES).toBe(50 * 1024 * 1024); // 50MB
      expect(LIBRARY_DEFAULTS.MAX_FILES_PER_PROJECT).toBe(500);
      expect(LIBRARY_DEFAULTS.MAX_TAGS_PER_FILE).toBe(20);
      expect(LIBRARY_DEFAULTS.MAX_TAG_LENGTH).toBe(50);
      expect(LIBRARY_DEFAULTS.DOWNLOAD_TIMEOUT_MS).toBe(60_000);
      expect(LIBRARY_DEFAULTS.LIST_DEFAULT_PAGE_SIZE).toBe(50);
      expect(LIBRARY_DEFAULTS.LIST_MAX_PAGE_SIZE).toBe(200);
    });
  });

  describe('LIBRARY_TAG_PATTERN', () => {
    it('accepts valid tags', () => {
      expect(LIBRARY_TAG_PATTERN.test('design')).toBe(true);
      expect(LIBRARY_TAG_PATTERN.test('api-docs')).toBe(true);
      expect(LIBRARY_TAG_PATTERN.test('v2')).toBe(true);
      expect(LIBRARY_TAG_PATTERN.test('123')).toBe(true);
    });

    it('rejects invalid tags', () => {
      expect(LIBRARY_TAG_PATTERN.test('')).toBe(false);
      expect(LIBRARY_TAG_PATTERN.test('UPPERCASE')).toBe(false);
      expect(LIBRARY_TAG_PATTERN.test('has spaces')).toBe(false);
      expect(LIBRARY_TAG_PATTERN.test('-starts-with-hyphen')).toBe(false);
      expect(LIBRARY_TAG_PATTERN.test('special@chars')).toBe(false);
    });
  });

  describe('LIBRARY_FILENAME_PATTERN', () => {
    it('accepts valid filenames', () => {
      expect(LIBRARY_FILENAME_PATTERN.test('report.pdf')).toBe(true);
      expect(LIBRARY_FILENAME_PATTERN.test('my-file.txt')).toBe(true);
      expect(LIBRARY_FILENAME_PATTERN.test('image 2024.png')).toBe(true);
      expect(LIBRARY_FILENAME_PATTERN.test('file_v2.doc')).toBe(true);
    });

    it('rejects filenames with shell metacharacters', () => {
      expect(LIBRARY_FILENAME_PATTERN.test('../etc/passwd')).toBe(false);
      expect(LIBRARY_FILENAME_PATTERN.test('file;rm -rf /')).toBe(false);
      expect(LIBRARY_FILENAME_PATTERN.test('$(evil)')).toBe(false);
      expect(LIBRARY_FILENAME_PATTERN.test('file`cmd`')).toBe(false);
    });

    it('rejects empty and dot-prefixed filenames', () => {
      expect(LIBRARY_FILENAME_PATTERN.test('')).toBe(false);
      expect(LIBRARY_FILENAME_PATTERN.test('.hidden')).toBe(false);
      expect(LIBRARY_FILENAME_PATTERN.test('-flag.txt')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests for service validation functions
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<Record<string, string>> = {}): Env {
  return overrides as unknown as Env;
}

describe('validateFilename', () => {
  it('accepts a valid filename', () => {
    expect(() => validateFilename('report.pdf', makeEnv())).not.toThrow();
  });

  it('rejects an empty filename', () => {
    expect(() => validateFilename('', makeEnv())).toThrow(/Filename must be/);
  });

  it('rejects a filename exceeding default max length', () => {
    const longName = 'a'.repeat(256) + '.txt';
    expect(() => validateFilename(longName, makeEnv())).toThrow(/Filename must be/);
  });

  it('accepts a filename at exactly the default max length', () => {
    const name = 'a'.repeat(251) + '.txt'; // 255 chars
    expect(() => validateFilename(name, makeEnv())).not.toThrow();
  });

  it('uses env override for max filename length', () => {
    const env = makeEnv({ LIBRARY_MAX_FILENAME_LENGTH: '10' });
    expect(() => validateFilename('short.txt', env)).not.toThrow(); // 9 chars
    expect(() => validateFilename('toolongname.txt', env)).toThrow(/Filename must be 1-10/);
  });

  it('rejects filenames with path traversal', () => {
    expect(() => validateFilename('../etc/passwd', makeEnv())).toThrow(/invalid characters/);
  });

  it('rejects filenames with shell metacharacters', () => {
    expect(() => validateFilename('$(evil).txt', makeEnv())).toThrow(/invalid characters/);
  });
});

describe('validateTag', () => {
  it('accepts a valid tag', () => {
    expect(() => validateTag('design', makeEnv())).not.toThrow();
  });

  it('rejects an empty tag', () => {
    expect(() => validateTag('', makeEnv())).toThrow(/Tag must be/);
  });

  it('rejects a tag exceeding max length', () => {
    const longTag = 'a'.repeat(51);
    expect(() => validateTag(longTag, makeEnv())).toThrow(/Tag must be/);
  });

  it('uses env override for max tag length', () => {
    const env = makeEnv({ LIBRARY_MAX_TAG_LENGTH: '5' });
    expect(() => validateTag('short', env)).not.toThrow();
    expect(() => validateTag('toolong', env)).toThrow(/Tag must be 1-5/);
  });

  it('rejects uppercase tags', () => {
    expect(() => validateTag('UPPER', makeEnv())).toThrow(/lowercase alphanumeric/);
  });

  it('rejects tags starting with hyphen', () => {
    expect(() => validateTag('-invalid', makeEnv())).toThrow(/lowercase alphanumeric/);
  });
});
