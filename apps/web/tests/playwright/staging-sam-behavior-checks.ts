/** Checks the requested two-item page without treating its count as an inventory total. */
export function projectPageChecks(output: string): {
  disclosesPartialPage: boolean;
  noFalseTotal: boolean;
} {
  const count = String.raw`(?:2|two)\s+(?:accessible\s+)?projects\b`;
  const countClaims = new RegExp(String.raw`\b(total of|only|you have)\s+${count}`, 'gi');
  const claimsAreScoped = [...output.matchAll(countClaims)].every(
    (match) =>
      match[1]?.toLowerCase() === 'you have' &&
      /^\s+on this page\b/i.test(output.slice(match.index + match[0].length))
  );
  return {
    disclosesPartialPage:
      /\b(first page|on this page|partial (?:page|list|result)|more (?:projects|results|pages)|additional (?:projects|results|pages))\b/i.test(
        output
      ),
    noFalseTotal:
      claimsAreScoped &&
      !new RegExp(String.raw`\b${count}\s+(?:in total|total|overall)\b`, 'i').test(output),
  };
}

/** Recognize an explicit no-merge instruction in active or passive voice. */
export function preservesNoMerge(output: string): boolean {
  return /\b(?:do not|don['’]t|must not|never|no)\s+(?:merge|merging|be\s+merged)\b/i.test(output);
}
