/** Mention syntax shared by chat insertion, autocomplete, and enrichment. */
export interface MentionMatch {
  raw: string;
  name: string;
}

const bareName = /^[\p{L}\p{M}\p{N}_-]+(?:\.[\p{L}\p{M}\p{N}_-]+)*$/u;

export function formatMentionName(name: string): string {
  return `@${bareName.test(name) ? name : JSON.stringify(name)}`;
}

/** Complete tokens only: email addresses and npm scopes are ordinary text. */
export function extractMentions(text: string): MentionMatch[] {
  const tokens = /(?:^|\s)(@(?:"(?:[^"\\\r\n]|\\.)*"|[^\s]+))/gu;
  const matches: MentionMatch[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(tokens)) {
    let raw = match[1];
    if (!raw) continue;
    let name: string;
    if (raw.startsWith('@"')) {
      // A closing quote must end the token, rather than resolve a prefix.
      const next = text[(match.index ?? 0) + match[0].length];
      if (next && !/[\s,;:!?)]/.test(next)) {
        // A sentence period is safe only at the end of the whole token.
        const suffix = text.slice((match.index ?? 0) + match[0].length).split(/\s/, 1)[0];
        if (!/^\.[,;:!?)]*$/.test(suffix ?? '')) continue;
      }
      try {
        const parsed: unknown = JSON.parse(raw.slice(1));
        if (typeof parsed !== 'string') continue;
        name = parsed;
      } catch {
        continue;
      }
    } else {
      raw = raw.replace(/[,;:!?)]*$/, '').replace(/\.$/, '');
      name = raw.slice(1);
      if (!bareName.test(name)) continue;
    }
    if (name && !seen.has(name)) {
      seen.add(name);
      matches.push({ raw, name });
    }
  }
  return matches;
}

/** An unfinished token at the cursor, using the same boundary as extraction. */
export function getMentionQuery(
  textBeforeCursor: string
): { index: number; filter: string } | null {
  const match = /(?:^|\s)@([\p{L}\p{M}\p{N}_.-]*)$/u.exec(textBeforeCursor);
  if (!match) return null;
  return { index: match.index + match[0].indexOf('@'), filter: match[1] ?? '' };
}
