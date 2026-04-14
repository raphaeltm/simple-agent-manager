import { describe, expect, it } from 'vitest';

import { sanitizeUrl } from '../../../src/lib/url-utils';

describe('sanitizeUrl', () => {
  it.each([
    ['allows http URLs', 'http://example.com', 'http://example.com'],
    ['allows https URLs', 'https://example.com/path?q=1', 'https://example.com/path?q=1'],
    ['blocks javascript: protocol', 'javascript:alert(1)', '#'],
    ['blocks data: protocol', 'data:text/html,<h1>hi</h1>', '#'],
    ['blocks vbscript: protocol', 'vbscript:MsgBox("hi")', '#'],
    ['returns # for empty string', '', '#'],
    ['returns # for malformed URLs', 'not a url', '#'],
    ['blocks ftp: protocol', 'ftp://files.example.com', '#'],
    ['preserves full URL including fragments', 'https://example.com/page#section', 'https://example.com/page#section'],
  ])('%s', (_, input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });
});
