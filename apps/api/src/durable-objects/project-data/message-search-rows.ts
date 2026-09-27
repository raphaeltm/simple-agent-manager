/**
 * Shared shaping for message search rows: role predicates, fault-isolated row mapping and snippets.
 */
import { buildSafeFtsQuery } from '../../lib/fts5';
import { log } from '../../lib/logger';
import { parseSearchResultRow, type SearchResultParsed } from './row-schemas';

export type SearchResult = {
  id: string;
  sessionId: string;
  role: string;
  snippet: string;
  createdAt: number;
  sessionTopic: string | null;
  sessionTaskId: string | null;
};

export function appendRoleCondition(
  conditions: string[],
  params: (string | number)[],
  roles: string[] | null
): void {
  if (!roles || roles.length === 0) return;
  conditions.push(`m.role IN (${roles.map(() => '?').join(', ')})`);
  params.push(...roles);
}

/** One malformed row degrades to a missing result, never a failed search (`.claude/rules/50`). */
export function mapSearchRows(
  rows: Record<string, unknown>[],
  query: string,
  source: 'fts' | 'keyword'
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const row of rows) {
    try {
      results.push(toSearchResult(parseSearchResultRow(row), query));
    } catch (error) {
      log.warn('messages.search_row_skipped', {
        source,
        messageId: typeof row.id === 'string' ? row.id : null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function toSearchResult(parsed: SearchResultParsed, query: string): SearchResult {
  return {
    id: parsed.id,
    sessionId: parsed.sessionId,
    role: parsed.role,
    snippet: extractSnippet(parsed.content, query),
    createdAt: parsed.createdAt,
    sessionTopic: parsed.sessionTopic,
    sessionTaskId: parsed.sessionTaskId,
  };
}

export function buildFtsQuery(query: string): string | null {
  return buildSafeFtsQuery(query);
}

export function extractSnippet(content: string, query: string): string {
  const lowerContent = content.toLowerCase();
  const matchIdx = lowerContent.indexOf(query.toLowerCase());
  if (matchIdx === -1) {
    return content.slice(0, 200) + (content.length > 200 ? '...' : '');
  }
  const start = Math.max(0, matchIdx - 80);
  const end = Math.min(content.length, matchIdx + query.length + 120);
  return (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
}
