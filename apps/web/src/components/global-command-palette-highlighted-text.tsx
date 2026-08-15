/** Render text with matched character indices highlighted. */
export function HighlightedText({ text, matches }: { text: string; matches: number[] }) {
  if (matches.length === 0) return <>{text}</>;

  const matchSet = new Set(matches);
  const parts: Array<{ text: string; highlighted: boolean }> = [];
  let current = '';
  let currentHighlighted = false;

  for (let i = 0; i < text.length; i++) {
    // text.length-bounded index, so text[i] is always defined here; the
    // `continue` is unreachable but required for type narrowing.
    const ch = text[i];
    if (ch === undefined) continue;
    const isMatch = matchSet.has(i);
    if (i === 0) {
      currentHighlighted = isMatch;
      current = ch;
    } else if (isMatch === currentHighlighted) {
      current += ch;
    } else {
      parts.push({ text: current, highlighted: currentHighlighted });
      current = ch;
      currentHighlighted = isMatch;
    }
  }
  if (current) parts.push({ text: current, highlighted: currentHighlighted });

  return (
    <>
      {parts.map((part, i) =>
        part.highlighted ? (
          <span key={i} className="text-accent font-semibold">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  );
}
