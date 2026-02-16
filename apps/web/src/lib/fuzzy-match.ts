/**
 * VS Code-style fuzzy matching with camelCase and word-boundary awareness.
 *
 * Returns a score and the indices of matched characters, or null if no match.
 * Higher scores = better matches.
 */

export interface FuzzyMatchResult {
  /** Higher = better match. Minimum 1 for any match. */
  score: number;
  /** Indices of matched characters in the target string. */
  matches: number[];
}

/** Check if a character is an uppercase letter. */
function isUpper(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}

/** Check if a character is a lowercase letter. */
function isLower(ch: string): boolean {
  return ch >= 'a' && ch <= 'z';
}

/** Check if a character is a digit. */
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** Check if position i is a word boundary in target. */
function isWordBoundary(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1]!;
  const curr = target[i]!;
  // Separators: /, ., -, _, space
  if (prev === '/' || prev === '.' || prev === '-' || prev === '_' || prev === ' ') return true;
  // camelCase: lowercase -> uppercase
  if (isLower(prev) && isUpper(curr)) return true;
  // letter -> digit or digit -> letter
  if ((isLower(prev) || isUpper(prev)) && isDigit(curr)) return true;
  if (isDigit(prev) && (isLower(curr) || isUpper(curr))) return true;
  return false;
}

/**
 * Fuzzy match a query against a target string.
 *
 * Characters in query must appear in order in target (subsequence matching).
 * Scoring rewards:
 * - Matches at word boundaries (camelCase, separators) — +10 per boundary match
 * - Consecutive matches — +5 per consecutive match
 * - Match at start of string — +15
 * - Each matched character — +1
 *
 * @returns FuzzyMatchResult if query matches target, null otherwise.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult | null {
  if (query.length === 0) {
    return { score: 0, matches: [] };
  }
  if (query.length > target.length) return null;

  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();
  const matches: number[] = [];
  let score = 0;

  let qi = 0; // query index
  for (let ti = 0; ti < target.length && qi < queryLower.length; ti++) {
    // Skip spaces in the query when the target character isn't a space.
    // This allows "work tab" to match "WorkspaceTabStrip" by treating
    // the space as a flexible word separator.
    while (qi < queryLower.length && queryLower[qi] === ' ' && targetLower[ti] !== ' ') {
      qi++;
    }
    if (qi >= queryLower.length) break;

    if (targetLower[ti] === queryLower[qi]) {
      matches.push(ti);

      // Base point for each match
      score += 1;

      // Start of string bonus
      if (ti === 0) score += 15;

      // Word boundary bonus
      if (isWordBoundary(target, ti)) score += 10;

      // Consecutive match bonus
      if (matches.length > 1 && ti === matches[matches.length - 2]! + 1) {
        score += 5;
      }

      qi++;
    }
  }

  // Skip any trailing spaces in the query
  while (qi < queryLower.length && queryLower[qi] === ' ') {
    qi++;
  }

  // All query characters must be matched
  if (qi < queryLower.length) return null;

  return { score, matches };
}

/**
 * Extract just the filename from a file path for display purposes.
 */
export function fileNameFromPath(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}
