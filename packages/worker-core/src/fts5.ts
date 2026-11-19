const FTS5_RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR']);

export function buildSafeFtsQuery(query: string): string | null {
  const cleaned = query.replace(/[^\w\s]/g, ' ').trim();
  if (!cleaned) return null;

  const words = cleaned
    .split(/\s+/)
    .filter((word) => word && !FTS5_RESERVED.has(word.toUpperCase()));

  return words.length > 0 ? words.join(' ') : null;
}
