import { describe, expect, it } from 'vitest';

import { isFilePathHref, parseFilePathRef } from '../../../src/components/MessageBubble';

describe('isFilePathHref', () => {
  it('returns false for http URLs', () => {
    expect(isFilePathHref('https://example.com')).toBe(false);
    expect(isFilePathHref('http://localhost:3000')).toBe(false);
  });

  it('returns false for mailto links', () => {
    expect(isFilePathHref('mailto:user@example.com')).toBe(false);
  });

  it('returns false for anchor links', () => {
    expect(isFilePathHref('#section')).toBe(false);
  });

  it('returns false for javascript protocol', () => {
    expect(isFilePathHref('javascript:void(0)')).toBe(false);
  });

  it('returns false for data URIs', () => {
    expect(isFilePathHref('data:text/html,<h1>hi</h1>')).toBe(false);
  });

  it('returns false for undefined/empty', () => {
    expect(isFilePathHref(undefined)).toBe(false);
    expect(isFilePathHref('')).toBe(false);
  });

  it('returns true for relative file paths', () => {
    expect(isFilePathHref('src/main.ts')).toBe(true);
    expect(isFilePathHref('./package.json')).toBe(true);
    expect(isFilePathHref('README.md')).toBe(true);
  });

  it('returns true for absolute file paths', () => {
    expect(isFilePathHref('/etc/config.yaml')).toBe(true);
  });

  it('returns true for paths with line numbers', () => {
    expect(isFilePathHref('src/main.ts:42')).toBe(true);
  });

  it('returns true for dotfiles', () => {
    expect(isFilePathHref('.gitignore')).toBe(true);
    expect(isFilePathHref('.env.local')).toBe(true);
  });

  it('returns false for bare words without dots or slashes', () => {
    expect(isFilePathHref('foobar')).toBe(false);
  });
});

describe('parseFilePathRef', () => {
  it('parses path without line number', () => {
    expect(parseFilePathRef('src/main.ts')).toEqual({ path: 'src/main.ts', line: null });
  });

  it('parses path with line number', () => {
    expect(parseFilePathRef('src/main.ts:42')).toEqual({ path: 'src/main.ts', line: 42 });
  });

  it('handles path with multiple colons (only last segment is line)', () => {
    expect(parseFilePathRef('C:/Users/file.ts:10')).toEqual({ path: 'C:/Users/file.ts', line: 10 });
  });

  it('does not parse non-numeric line number', () => {
    expect(parseFilePathRef('file.ts:abc')).toEqual({ path: 'file.ts:abc', line: null });
  });

  it('handles simple filename', () => {
    expect(parseFilePathRef('package.json')).toEqual({ path: 'package.json', line: null });
  });
});
