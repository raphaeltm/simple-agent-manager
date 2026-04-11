import { describe, expect, it } from 'vitest';

import {
  LIBRARY_DEFAULTS,
  LIBRARY_DIRECTORY_SEGMENT_PATTERN,
  validateDirectoryPath,
} from '../../src/types/library';

describe('LIBRARY_DIRECTORY_SEGMENT_PATTERN', () => {
  it('accepts simple alphanumeric names', () => {
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('marketing')).toBe(true);
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('docs2026')).toBe(true);
  });

  it('accepts names with dots, hyphens, underscores, spaces', () => {
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('my-folder')).toBe(true);
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('my_folder')).toBe(true);
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('v2.0')).toBe(true);
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('My Folder')).toBe(true);
  });

  it('rejects names starting with non-alphanumeric', () => {
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('.hidden')).toBe(false);
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('-flag')).toBe(false);
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('_private')).toBe(false);
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test(' spaced')).toBe(false);
  });

  it('rejects names with shell metacharacters', () => {
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('foo;bar')).toBe(false);
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('foo|bar')).toBe(false);
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('foo&bar')).toBe(false);
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('foo$bar')).toBe(false);
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('foo`bar')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(LIBRARY_DIRECTORY_SEGMENT_PATTERN.test('')).toBe(false);
  });
});

describe('validateDirectoryPath', () => {
  describe('normalization', () => {
    it('returns root as-is', () => {
      expect(validateDirectoryPath('/')).toBe('/');
    });

    it('adds leading slash if missing', () => {
      expect(validateDirectoryPath('marketing/')).toBe('/marketing/');
    });

    it('adds trailing slash if missing', () => {
      expect(validateDirectoryPath('/marketing')).toBe('/marketing/');
    });

    it('adds both slashes if missing', () => {
      expect(validateDirectoryPath('marketing')).toBe('/marketing/');
    });

    it('normalizes backslashes to forward slashes', () => {
      expect(validateDirectoryPath('\\marketing\\brand\\')).toBe('/marketing/brand/');
    });

    it('collapses multiple consecutive slashes', () => {
      expect(validateDirectoryPath('///marketing///brand///')).toBe('/marketing/brand/');
    });

    it('handles mixed backslashes and multiple slashes', () => {
      expect(validateDirectoryPath('\\\\marketing\\\\brand//')).toBe('/marketing/brand/');
    });
  });

  describe('valid paths', () => {
    it('accepts single-level directory', () => {
      expect(validateDirectoryPath('/docs/')).toBe('/docs/');
    });

    it('accepts multi-level directory', () => {
      expect(validateDirectoryPath('/docs/guides/api/')).toBe('/docs/guides/api/');
    });

    it('accepts names with allowed special chars', () => {
      expect(validateDirectoryPath('/my-folder/v2.0/sub_dir/')).toBe('/my-folder/v2.0/sub_dir/');
    });

    it('accepts names with spaces', () => {
      expect(validateDirectoryPath('/My Folder/Sub Folder/')).toBe('/My Folder/Sub Folder/');
    });
  });

  describe('traversal attacks', () => {
    it('rejects .. segments', () => {
      expect(() => validateDirectoryPath('/marketing/../etc/')).toThrow(
        'cannot contain ".." or "."',
      );
    });

    it('rejects . segments', () => {
      expect(() => validateDirectoryPath('/marketing/./brand/')).toThrow(
        'cannot contain ".." or "."',
      );
    });

    it('rejects standalone ..', () => {
      expect(() => validateDirectoryPath('/../')).toThrow('cannot contain ".." or "."');
    });

    it('rejects standalone .', () => {
      expect(() => validateDirectoryPath('/./')).toThrow('cannot contain ".." or "."');
    });

    it('rejects null bytes', () => {
      expect(() => validateDirectoryPath('/marketing\0/')).toThrow('null bytes');
    });

    it('rejects null bytes in middle of path', () => {
      expect(() => validateDirectoryPath('/mar\0keting/')).toThrow('null bytes');
    });
  });

  describe('segment validation', () => {
    it('rejects segments starting with dot', () => {
      expect(() => validateDirectoryPath('/.hidden/')).toThrow('Invalid directory segment');
    });

    it('rejects segments with shell metacharacters', () => {
      expect(() => validateDirectoryPath('/foo;bar/')).toThrow('Invalid directory segment');
    });

    it('rejects segments with pipe', () => {
      expect(() => validateDirectoryPath('/foo|bar/')).toThrow('Invalid directory segment');
    });

    it('rejects segments starting with hyphen', () => {
      expect(() => validateDirectoryPath('/-flag/')).toThrow('Invalid directory segment');
    });

    it('rejects segments with slashes embedded after normalization still work', () => {
      // Path with unicode or unusual chars
      expect(() => validateDirectoryPath('/foo<bar>/')).toThrow('Invalid directory segment');
    });
  });

  describe('depth limits', () => {
    it('accepts path at max depth', () => {
      const segments = Array.from({ length: 10 }, (_, i) => `d${i}`).join('/');
      const path = `/${segments}/`;
      expect(validateDirectoryPath(path)).toBe(path);
    });

    it('rejects path exceeding max depth', () => {
      const segments = Array.from({ length: 11 }, (_, i) => `d${i}`).join('/');
      expect(() => validateDirectoryPath(`/${segments}/`)).toThrow('exceeds maximum of 10');
    });

    it('respects custom max depth', () => {
      expect(() => validateDirectoryPath('/a/b/c/', 2)).toThrow('exceeds maximum of 2');
    });

    it('accepts path within custom max depth', () => {
      expect(validateDirectoryPath('/a/b/', 2)).toBe('/a/b/');
    });
  });

  describe('length limits', () => {
    it('rejects path exceeding max length', () => {
      // Build a path that exceeds 500 chars
      const longSegment = 'a'.repeat(100);
      const segments = Array.from({ length: 6 }, () => longSegment).join('/');
      const path = `/${segments}/`;
      expect(path.length).toBeGreaterThan(500);
      expect(() => validateDirectoryPath(path)).toThrow('exceeds maximum of');
    });

    it('respects custom max length', () => {
      expect(() => validateDirectoryPath('/marketing/brand/', 10, 10)).toThrow(
        'exceeds maximum of 10',
      );
    });
  });

  describe('defaults', () => {
    it('uses LIBRARY_DEFAULTS for max depth', () => {
      expect(LIBRARY_DEFAULTS.MAX_DIRECTORY_DEPTH).toBe(10);
    });

    it('uses LIBRARY_DEFAULTS for max path length', () => {
      expect(LIBRARY_DEFAULTS.MAX_DIRECTORY_PATH_LENGTH).toBe(500);
    });

    it('uses LIBRARY_DEFAULTS for max directories per project', () => {
      expect(LIBRARY_DEFAULTS.MAX_DIRECTORIES_PER_PROJECT).toBe(500);
    });
  });
});
