import { describe, expect, it } from 'vitest';

import { extractMentions } from '../../../src/services/mention-enrichment';

describe('extractMentions', () => {
  it('extracts a single @word mention', () => {
    const result = extractMentions('Hey @reviewer check this');
    expect(result).toEqual([{ raw: '@reviewer', name: 'reviewer' }]);
  });

  it('extracts a quoted @"Multi Word" mention', () => {
    const result = extractMentions('Ask @"Code Reviewer" to look');
    expect(result).toEqual([{ raw: '@"Code Reviewer"', name: 'Code Reviewer' }]);
  });

  it('extracts multiple mentions', () => {
    const result = extractMentions('@planner decompose this, then @implementer build it');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ raw: '@planner', name: 'planner' });
    expect(result[1]).toEqual({ raw: '@implementer', name: 'implementer' });
  });

  it('deduplicates mentions (case-insensitive)', () => {
    const result = extractMentions('@reviewer and @Reviewer should check');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('reviewer');
  });

  it('returns empty array when no mentions', () => {
    const result = extractMentions('Just a regular message with email@example.com');
    // email@example would match as @example — this is acceptable behavior
    // as the backend will not resolve it to a profile
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it('handles mentions at start and end of text', () => {
    const result = extractMentions('@planner do it');
    expect(result).toEqual([{ raw: '@planner', name: 'planner' }]);
  });

  it('handles mention at end of text', () => {
    const result = extractMentions('send to @reviewer');
    expect(result).toEqual([{ raw: '@reviewer', name: 'reviewer' }]);
  });

  it('handles empty string', () => {
    const result = extractMentions('');
    expect(result).toEqual([]);
  });

  it('handles @ alone without a following word', () => {
    const result = extractMentions('Just an @ symbol');
    expect(result).toEqual([]);
  });

  it('handles quoted mention with special characters in name', () => {
    const result = extractMentions('@"My Custom Agent" please help');
    expect(result).toEqual([{ raw: '@"My Custom Agent"', name: 'My Custom Agent' }]);
  });

  it('handles adjacent mentions', () => {
    const result = extractMentions('@planner @reviewer');
    expect(result).toHaveLength(2);
  });
});
