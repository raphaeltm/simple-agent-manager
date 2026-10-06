// =============================================================================
// Client-side library search — pure ranked matcher + index builder
// =============================================================================
//
// No I/O, no React. Given the full set of project files (swept client-side by
// useLibraryIndex), this module builds a normalized search index and ranks
// files against a query. Ranking tiers (high → low):
//   exact > prefix > word-boundary > substring > subsequence
// Tie-break within a tier: earliest match position, then shortest field length.
// Matching spans filename, tag names, directory path, and description.
//
// Custom matcher by design (NOT fuse.js): the corpus is capped at a few hundred
// files, the ranking rules are simple and deterministic, and we avoid a runtime
// dependency.

import type { FileWithTags } from '../components/library/types';

export const MATCH_TIER = {
  NONE: 0,
  SUBSEQUENCE: 1,
  SUBSTRING: 2,
  WORD_BOUNDARY: 3,
  PREFIX: 4,
  EXACT: 5,
} as const;

export type MatchTier = (typeof MATCH_TIER)[keyof typeof MATCH_TIER];

/** A single file's normalized searchable fields. */
export interface IndexedFile {
  file: FileWithTags;
  filename: string;
  description: string;
  directory: string;
  tags: string[];
}

export interface LibraryIndex {
  files: IndexedFile[];
}

export interface FileMatch {
  file: FileWithTags;
  tier: MatchTier;
  /** Position of the match within the best-matching field. */
  position: number;
  /** Length of the best-matching field (shorter ranks higher on ties). */
  length: number;
}

/** Normalize a string for matching: NFC + lowercase. */
function normalize(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

/** Public helper so callers can normalize a raw query the same way. */
export function normalizeQuery(raw: string): string {
  return normalize(raw.trim());
}

function isWordBoundary(haystack: string, idx: number): boolean {
  if (idx === 0) return true;
  return !/[\p{L}\p{N}]/u.test(haystack.charAt(idx - 1));
}

/** Earliest index where `query` occurs at a word boundary, or -1. */
function findWordBoundaryMatch(haystack: string, query: string): number {
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(query, from);
    if (idx === -1) return -1;
    if (isWordBoundary(haystack, idx)) return idx;
    from = idx + 1;
  }
}

/** Index of the first matched char if `query` is a subsequence of `haystack`, else -1. */
function subsequencePosition(haystack: string, query: string): number {
  let qi = 0;
  let first = -1;
  for (let i = 0; i < haystack.length && qi < query.length; i++) {
    if (haystack[i] === query[qi]) {
      if (qi === 0) first = i;
      qi++;
    }
  }
  return qi === query.length ? first : -1;
}

interface FieldScore {
  tier: MatchTier;
  position: number;
  length: number;
}

/** Score a single normalized field against an already-normalized query. */
function scoreField(haystack: string, query: string): FieldScore | null {
  if (!haystack) return null;
  const length = haystack.length;
  if (haystack === query) return { tier: MATCH_TIER.EXACT, position: 0, length };
  if (haystack.startsWith(query)) return { tier: MATCH_TIER.PREFIX, position: 0, length };
  const wb = findWordBoundaryMatch(haystack, query);
  if (wb !== -1) return { tier: MATCH_TIER.WORD_BOUNDARY, position: wb, length };
  const sub = haystack.indexOf(query);
  if (sub !== -1) return { tier: MATCH_TIER.SUBSTRING, position: sub, length };
  const seq = subsequencePosition(haystack, query);
  if (seq !== -1) return { tier: MATCH_TIER.SUBSEQUENCE, position: seq, length };
  return null;
}

/** True if `a` is a strictly better match than `b`. */
function isBetter(a: FieldScore, b: FieldScore): boolean {
  if (a.tier !== b.tier) return a.tier > b.tier;
  if (a.position !== b.position) return a.position < b.position;
  return a.length < b.length;
}

/**
 * Build a search index from the full file set. Pure — call once per sweep.
 */
export function buildIndex(files: FileWithTags[]): LibraryIndex {
  return {
    files: files.map((file) => ({
      file,
      filename: normalize(file.filename),
      description: normalize(file.description ?? ''),
      directory: normalize(file.directory),
      tags: file.tags.map((t) => normalize(t.tag)),
    })),
  };
}

/**
 * Match a single indexed file against a normalized query. Returns the best
 * field match, or null if no field matches. Fields are checked in priority
 * order (filename → tags → directory → description) so that a complete tie
 * resolves in favor of the filename.
 */
export function matchFile(indexed: IndexedFile, query: string): FileMatch | null {
  let best: FieldScore | null = null;
  const fields = [indexed.filename, ...indexed.tags, indexed.directory, indexed.description];
  for (const field of fields) {
    const score = scoreField(field, query);
    if (score && (best === null || isBetter(score, best))) {
      best = score;
    }
  }
  if (!best) return null;
  return { file: indexed.file, tier: best.tier, position: best.position, length: best.length };
}

/** Comparator: best match first, stable on filename for deterministic order. */
function compareMatches(a: FileMatch, b: FileMatch): number {
  if (a.tier !== b.tier) return b.tier - a.tier;
  if (a.position !== b.position) return a.position - b.position;
  if (a.length !== b.length) return a.length - b.length;
  return a.file.filename.localeCompare(b.file.filename);
}

/**
 * Search the index. Returns ranked matches for a non-empty query, or null when
 * the query is empty (caller should show the unfiltered/current-directory view).
 */
export function searchIndex(index: LibraryIndex, rawQuery: string): FileMatch[] | null {
  const query = normalizeQuery(rawQuery);
  if (!query) return null;
  const matches: FileMatch[] = [];
  for (const indexed of index.files) {
    const match = matchFile(indexed, query);
    if (match) matches.push(match);
  }
  matches.sort(compareMatches);
  return matches;
}
