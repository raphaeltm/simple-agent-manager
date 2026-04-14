import { describe, expect, it } from 'vitest';

import { sanitizeUrl } from '../../../src/lib/url-utils';

describe('sanitizeUrl', () => {
  it('allows http URLs', () => {
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com');
  });

  it('allows https URLs', () => {
    expect(sanitizeUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
  });

  it('blocks javascript: protocol', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('#');
  });

  it('blocks data: protocol', () => {
    expect(sanitizeUrl('data:text/html,<h1>hi</h1>')).toBe('#');
  });

  it('blocks vbscript: protocol', () => {
    expect(sanitizeUrl('vbscript:MsgBox("hi")')).toBe('#');
  });

  it('returns # for empty string', () => {
    expect(sanitizeUrl('')).toBe('#');
  });

  it('returns # for malformed URLs', () => {
    expect(sanitizeUrl('not a url')).toBe('#');
  });

  it('blocks ftp: protocol', () => {
    expect(sanitizeUrl('ftp://files.example.com')).toBe('#');
  });

  it('preserves full URL including fragments', () => {
    const url = 'https://example.com/page#section';
    expect(sanitizeUrl(url)).toBe(url);
  });
});
