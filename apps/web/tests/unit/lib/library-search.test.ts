import { describe, expect, it } from 'vitest';

import type { FileWithTags } from '../../../src/components/library/types';
import {
  buildIndex,
  MATCH_TIER,
  matchFile,
  normalizeQuery,
  searchIndex,
} from '../../../src/lib/library-search';

function makeFile(overrides: Partial<FileWithTags> = {}): FileWithTags {
  return {
    id: overrides.id ?? 'f1',
    projectId: 'proj-1',
    filename: overrides.filename ?? 'report.txt',
    directory: overrides.directory ?? '/',
    mimeType: overrides.mimeType ?? 'text/plain',
    sizeBytes: overrides.sizeBytes ?? 100,
    description: overrides.description ?? null,
    uploadedBy: 'user-1',
    uploadSource: overrides.uploadSource ?? 'user',
    uploadSessionId: null,
    uploadTaskId: null,
    replacedAt: null,
    replacedBy: null,
    status: 'ready',
    extractedTextPreview: null,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    tags: overrides.tags ?? [],
    ...overrides,
  };
}

describe('library-search — normalizeQuery', () => {
  it('trims and lowercases', () => {
    expect(normalizeQuery('  Report  ')).toBe('report');
  });

  it('NFC-normalizes composed characters', () => {
    // 'é' as decomposed (e + combining acute) normalizes to composed form
    const decomposed = 'cafe\u0301';
    expect(normalizeQuery(decomposed)).toBe('café');
  });
});

describe('library-search — matchFile tiers', () => {
  const index = buildIndex([makeFile({ filename: 'report.txt' })]);
  const indexed = index.files[0]!;

  it('ranks an exact filename match highest', () => {
    const m = matchFile({ ...indexed, filename: 'report' }, 'report');
    expect(m?.tier).toBe(MATCH_TIER.EXACT);
  });

  it('ranks a prefix match', () => {
    const m = matchFile(indexed, 'rep');
    expect(m?.tier).toBe(MATCH_TIER.PREFIX);
  });

  it('ranks a word-boundary match above a plain substring', () => {
    const wb = buildIndex([makeFile({ filename: 'my-report.txt' })]).files[0]!;
    const m = matchFile(wb, 'report');
    expect(m?.tier).toBe(MATCH_TIER.WORD_BOUNDARY);
  });

  it('ranks a substring match', () => {
    const sub = buildIndex([makeFile({ filename: 'quarterlyreport.txt' })]).files[0]!;
    const m = matchFile(sub, 'lyrep');
    expect(m?.tier).toBe(MATCH_TIER.SUBSTRING);
  });

  it('ranks a subsequence match lowest', () => {
    const seq = buildIndex([makeFile({ filename: 'report.txt' })]).files[0]!;
    const m = matchFile(seq, 'rpt');
    expect(m?.tier).toBe(MATCH_TIER.SUBSEQUENCE);
  });

  it('returns null when no field matches', () => {
    expect(matchFile(indexed, 'zzzzz')).toBeNull();
  });
});

describe('library-search — matchFile across fields', () => {
  it('matches on tag name', () => {
    const f = buildIndex([
      makeFile({ filename: 'a.txt', tags: [{ fileId: 'f1', tag: 'invoice', tagSource: 'user' }] }),
    ]).files[0]!;
    expect(matchFile(f, 'invoice')?.tier).toBe(MATCH_TIER.EXACT);
  });

  it('matches on directory path', () => {
    const f = buildIndex([makeFile({ filename: 'a.txt', directory: '/marketing/brand/' })]).files[0]!;
    const m = matchFile(f, 'marketing');
    expect(m).not.toBeNull();
  });

  it('matches on description', () => {
    const f = buildIndex([makeFile({ filename: 'a.txt', description: 'annual budget summary' })]).files[0]!;
    const m = matchFile(f, 'budget');
    expect(m).not.toBeNull();
  });
});

describe('library-search — searchIndex ranking and ordering', () => {
  it('returns null for an empty query', () => {
    const index = buildIndex([makeFile()]);
    expect(searchIndex(index, '')).toBeNull();
    expect(searchIndex(index, '   ')).toBeNull();
  });

  it('orders exact > prefix > substring', () => {
    const index = buildIndex([
      makeFile({ id: 'sub', filename: 'quarterlyreportfinal.txt' }),
      makeFile({ id: 'exact', filename: 'report' }),
      makeFile({ id: 'prefix', filename: 'report-2026.txt' }),
    ]);
    const results = searchIndex(index, 'report')!;
    expect(results.map((r) => r.file.id)).toEqual(['exact', 'prefix', 'sub']);
  });

  it('tie-breaks within a tier by field length then filename', () => {
    const index = buildIndex([
      makeFile({ id: 'long', filename: 'reporting-system.txt' }),
      makeFile({ id: 'short', filename: 'report.txt' }),
    ]);
    const results = searchIndex(index, 'report')!;
    // both prefix matches at position 0; shorter field ranks first
    expect(results[0]!.file.id).toBe('short');
  });

  it('spans files across all directories (cross-directory)', () => {
    const index = buildIndex([
      makeFile({ id: 'root', filename: 'budget.txt', directory: '/' }),
      makeFile({ id: 'nested', filename: 'budget-q2.txt', directory: '/finance/2026/' }),
    ]);
    const results = searchIndex(index, 'budget')!;
    expect(results.map((r) => r.file.id).sort()).toEqual(['nested', 'root']);
  });

  it('excludes non-matching files', () => {
    const index = buildIndex([
      makeFile({ id: 'a', filename: 'report.txt' }),
      makeFile({ id: 'b', filename: 'invoice.pdf' }),
    ]);
    const results = searchIndex(index, 'report')!;
    expect(results.map((r) => r.file.id)).toEqual(['a']);
  });
});
