/**
 * Desktop column count for a card grid of `count` items, chosen so the last row is full or
 * nearly full (7 → 4+3, 8 → 4+4, 6 → 3+3, 5 → 3+2). Phones and tablets use auto-fill instead.
 */
export function gridColumns(count: number): number {
  if (count <= 4) return Math.max(count, 1);
  if (count % 4 === 0) return 4;
  if (count % 3 === 0 || count === 5) return 3;
  return 4;
}
