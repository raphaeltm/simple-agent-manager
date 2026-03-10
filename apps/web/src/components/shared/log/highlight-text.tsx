import type { ReactNode } from 'react';

/**
 * Highlight occurrences of `term` within `text` by wrapping matches in <mark>.
 * Returns the original string if no term is provided or no match is found.
 * Regex special characters in the search term are escaped.
 */
export function highlightText(text: string, term: string | undefined): ReactNode {
  if (!term || term.length === 0) return text;

  // Escape regex special chars in the search term
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);

  if (parts.length === 1) return text; // no match

  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark key={i} className="bg-accent-tint text-fg-primary rounded-[2px] px-px">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
