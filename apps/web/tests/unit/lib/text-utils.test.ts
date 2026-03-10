import { describe, expect, it } from 'vitest';
import { stripMarkdown } from '../../../src/lib/text-utils';

describe('stripMarkdown', () => {
  it('strips bold markers', () => {
    expect(stripMarkdown('**bold text**')).toBe('bold text');
  });

  it('strips italic markers with asterisks', () => {
    expect(stripMarkdown('*italic text*')).toBe('italic text');
  });

  it('strips bold markers with underscores', () => {
    expect(stripMarkdown('__bold text__')).toBe('bold text');
  });

  it('strips italic markers with underscores', () => {
    expect(stripMarkdown('_italic text_')).toBe('italic text');
  });

  it('strips strikethrough markers', () => {
    expect(stripMarkdown('~~deleted~~')).toBe('deleted');
  });

  it('strips inline code markers', () => {
    expect(stripMarkdown('run `npm install`')).toBe('run npm install');
  });

  it('strips heading markers', () => {
    expect(stripMarkdown('# Heading')).toBe('Heading');
    expect(stripMarkdown('## Sub-heading')).toBe('Sub-heading');
    expect(stripMarkdown('###### Deep heading')).toBe('Deep heading');
  });

  it('strips link syntax keeping label', () => {
    expect(stripMarkdown('[click here](https://example.com)')).toBe('click here');
  });

  it('handles mixed markdown', () => {
    expect(stripMarkdown('**README.md** Task Title Generator')).toBe('README.md Task Title Generator');
  });

  it('strips heading at start of line in mixed content', () => {
    expect(stripMarkdown('# **README.md** Task Title')).toBe('README.md Task Title');
  });

  it('returns plain text unchanged', () => {
    expect(stripMarkdown('plain text')).toBe('plain text');
  });

  it('trims whitespace', () => {
    expect(stripMarkdown('  hello  ')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(stripMarkdown('')).toBe('');
  });
});
