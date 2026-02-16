import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fileNameFromPath } from '../../../src/lib/fuzzy-match';

describe('fuzzyMatch', () => {
  it('returns score 0 and empty matches for empty query', () => {
    const result = fuzzyMatch('', 'WorkspaceTabStrip');
    expect(result).toEqual({ score: 0, matches: [] });
  });

  it('returns null when query is longer than target', () => {
    expect(fuzzyMatch('abcdef', 'abc')).toBeNull();
  });

  it('returns null when no subsequence match exists', () => {
    expect(fuzzyMatch('xyz', 'WorkspaceTabStrip')).toBeNull();
  });

  // ── camelCase matching ──

  it('matches camelCase initials: "WTS" → "WorkspaceTabStrip"', () => {
    const result = fuzzyMatch('WTS', 'WorkspaceTabStrip');
    expect(result).not.toBeNull();
    // W at 0, T at 9, S at 12
    expect(result!.matches).toEqual([0, 9, 12]);
  });

  it('matches lowercase camelCase initials: "wts" → "WorkspaceTabStrip"', () => {
    const result = fuzzyMatch('wts', 'WorkspaceTabStrip');
    expect(result).not.toBeNull();
    expect(result!.matches).toEqual([0, 9, 12]);
  });

  it('matches "uto" → "useTabOrder" (camelCase boundary on T)', () => {
    const result = fuzzyMatch('uto', 'useTabOrder');
    expect(result).not.toBeNull();
    // u at 0, t at 3 (camelCase boundary), o at 6 (camelCase boundary)
    expect(result!.matches).toEqual([0, 3, 6]);
  });

  // ── Word boundary / path matching ──

  it('matches path separators: "src/comp" → "src/components/Foo.tsx"', () => {
    const result = fuzzyMatch('src/comp', 'src/components/Foo.tsx');
    expect(result).not.toBeNull();
    // Should match characters contiguously at start
    expect(result!.matches).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('matches with dot separator: "f.ts" → "fuzzy-match.ts"', () => {
    const result = fuzzyMatch('f.ts', 'fuzzy-match.ts');
    expect(result).not.toBeNull();
  });

  it('matches hyphenated names: "fm" → "fuzzy-match"', () => {
    const result = fuzzyMatch('fm', 'fuzzy-match');
    expect(result).not.toBeNull();
    // f at 0 (start), m at 6 (after hyphen = word boundary)
    expect(result!.matches).toEqual([0, 6]);
  });

  // ── Space-separated queries ──

  it('matches space-separated words: "work tab" → "WorkspaceTabStrip"', () => {
    const result = fuzzyMatch('work tab', 'WorkspaceTabStrip');
    expect(result).not.toBeNull();
    // Space in query is skipped (no space in target), then t-a-b matched
    // w(0) o(1) r(2) k(3) [space skipped] t(9) a(10) b(11)
    expect(result!.matches).toEqual([0, 1, 2, 3, 9, 10, 11]);
  });

  it('matches "my api" → "My API Worker" (spaces in target)', () => {
    const result = fuzzyMatch('my api', 'My API Worker');
    expect(result).not.toBeNull();
    // M at 0, y at 1, space at 2, a at 3, p at 4, i at 5
    expect(result!.matches).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // ── Scoring ──

  it('scores start-of-string matches higher', () => {
    const startMatch = fuzzyMatch('work', 'WorkspaceTabStrip');
    const midMatch = fuzzyMatch('work', 'myWorkspace');
    expect(startMatch).not.toBeNull();
    expect(midMatch).not.toBeNull();
    expect(startMatch!.score).toBeGreaterThan(midMatch!.score);
  });

  it('scores contiguous matches higher than scattered', () => {
    const contiguous = fuzzyMatch('tab', 'TabStrip');
    const scattered = fuzzyMatch('tab', 'TrashAbBin');
    expect(contiguous).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(contiguous!.score).toBeGreaterThan(scattered!.score);
  });

  it('scores word-boundary matches higher', () => {
    // "ts" matching at camelCase boundaries T,S in WorkspaceTabStrip
    const boundary = fuzzyMatch('ts', 'WorkspaceTabStrip');
    // "ts" matching in "cats" (no boundary)
    const noBoundary = fuzzyMatch('ts', 'cats');
    expect(boundary).not.toBeNull();
    expect(noBoundary).not.toBeNull();
    expect(boundary!.score).toBeGreaterThan(noBoundary!.score);
  });

  // ── Edge cases ──

  it('matches exact string', () => {
    const result = fuzzyMatch('hello', 'hello');
    expect(result).not.toBeNull();
    expect(result!.matches).toEqual([0, 1, 2, 3, 4]);
  });

  it('matches single character', () => {
    const result = fuzzyMatch('w', 'Workspace');
    expect(result).not.toBeNull();
    expect(result!.matches).toEqual([0]);
  });

  it('is case-insensitive', () => {
    const upper = fuzzyMatch('WTS', 'WorkspaceTabStrip');
    const lower = fuzzyMatch('wts', 'WorkspaceTabStrip');
    expect(upper).not.toBeNull();
    expect(lower).not.toBeNull();
    expect(upper!.score).toBe(lower!.score);
    expect(upper!.matches).toEqual(lower!.matches);
  });

  it('matches digit boundaries', () => {
    const result = fuzzyMatch('v2', 'fileV2Final');
    expect(result).not.toBeNull();
  });
});

describe('fileNameFromPath', () => {
  it('extracts filename from path', () => {
    expect(fileNameFromPath('src/components/Foo.tsx')).toBe('Foo.tsx');
  });

  it('handles path with no slashes', () => {
    expect(fileNameFromPath('Foo.tsx')).toBe('Foo.tsx');
  });

  it('handles trailing slash', () => {
    expect(fileNameFromPath('src/')).toBe('');
  });

  it('handles root-relative path', () => {
    expect(fileNameFromPath('/etc/config.json')).toBe('config.json');
  });
});
