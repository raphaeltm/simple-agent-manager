import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { highlightText } from '../../../../../src/components/shared/log/highlight-text';

describe('highlightText', () => {
  it('returns plain string when term is undefined', () => {
    expect(highlightText('hello world', undefined)).toBe('hello world');
  });

  it('returns plain string when term is empty', () => {
    expect(highlightText('hello world', '')).toBe('hello world');
  });

  it('returns plain string when no match found', () => {
    expect(highlightText('hello world', 'zzz')).toBe('hello world');
  });

  it('wraps matching text in <mark> elements', () => {
    const result = highlightText('hello world hello', 'hello');
    const { container } = render(<span>{result}</span>);
    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBe(2);
    expect(marks[0]!.textContent).toBe('hello');
    expect(marks[1]!.textContent).toBe('hello');
  });

  it('is case-insensitive', () => {
    const result = highlightText('Hello HELLO hElLo', 'hello');
    const { container } = render(<span>{result}</span>);
    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBe(3);
  });

  it('escapes regex special characters', () => {
    const result = highlightText('file.ts (test)', 'file.ts (test)');
    const { container } = render(<span>{result}</span>);
    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBe(1);
    expect(marks[0]!.textContent).toBe('file.ts (test)');
  });

  it('does not match across regex without escaping', () => {
    // Without escaping, "." would match any char — ensure it only matches literal "."
    const result = highlightText('fileXts', 'file.ts');
    expect(result).toBe('fileXts'); // no match — plain string returned
  });
});
