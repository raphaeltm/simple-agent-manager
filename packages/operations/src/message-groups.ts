export interface TokenRow {
  id: string;
  role: string;
  content: string;
  createdAt: number;
}

const GROUPABLE_ROLES = new Set(['assistant', 'tool', 'thinking']);
export function groupTokensIntoMessages(tokens: TokenRow[]): TokenRow[] {
  const grouped: TokenRow[] = [];
  for (const token of tokens) {
    const last = grouped[grouped.length - 1];
    if (last && last.role === token.role && GROUPABLE_ROLES.has(token.role)) {
      last.content += token.content;
    } else {
      grouped.push({ ...token });
    }
  }
  return grouped;
}
