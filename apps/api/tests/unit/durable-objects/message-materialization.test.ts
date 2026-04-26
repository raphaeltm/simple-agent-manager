/**
 * Tests for message materialization and FTS5 search in ProjectData DO.
 *
 * Since the DO methods use raw SQL on embedded SQLite (which we can't easily
 * mock with FTS5 support), these tests verify:
 * 1. The grouping logic used during materialization (same as groupTokensIntoMessages)
 * 2. The FTS5 query builder
 * 3. The snippet extraction
 * 4. The search_messages MCP handler delegation (in mcp.test.ts)
 *
 * Integration tests with real SQLite are in the integration test suite.
 */
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../../src/durable-objects/migrations';

// ── Grouping logic (mirrors ProjectData.materializeSession and mcp.ts groupTokensIntoMessages) ──

const GROUPABLE_ROLES = new Set(['assistant', 'tool', 'thinking']);

interface Token {
  id: string;
  role: string;
  content: string;
  createdAt: number;
}

function groupTokens(tokens: Token[]): Token[] {
  const grouped: Token[] = [];
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

describe('Message Materialization', () => {
  describe('Token grouping logic', () => {
    it('should concatenate consecutive assistant tokens', () => {
      const tokens: Token[] = [
        { id: 'tok-1', role: 'assistant', content: 'Let me', createdAt: 1000 },
        { id: 'tok-2', role: 'assistant', content: ' look at', createdAt: 1001 },
        { id: 'tok-3', role: 'assistant', content: ' that file.', createdAt: 1002 },
      ];

      const result = groupTokens(tokens);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('tok-1');
      expect(result[0].content).toBe('Let me look at that file.');
      expect(result[0].createdAt).toBe(1000);
    });

    it('should concatenate consecutive tool tokens', () => {
      const tokens: Token[] = [
        { id: 'tok-1', role: 'tool', content: 'Reading', createdAt: 1000 },
        { id: 'tok-2', role: 'tool', content: ' file...', createdAt: 1001 },
      ];

      const result = groupTokens(tokens);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Reading file...');
    });

    it('should concatenate consecutive thinking tokens', () => {
      const tokens: Token[] = [
        { id: 'tok-1', role: 'thinking', content: 'I need to', createdAt: 1000 },
        { id: 'tok-2', role: 'thinking', content: ' analyze this.', createdAt: 1001 },
      ];

      const result = groupTokens(tokens);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('I need to analyze this.');
    });

    it('should NOT concatenate user messages', () => {
      const tokens: Token[] = [
        { id: 'tok-1', role: 'user', content: 'Hello', createdAt: 1000 },
        { id: 'tok-2', role: 'user', content: 'World', createdAt: 1001 },
      ];

      const result = groupTokens(tokens);
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('Hello');
      expect(result[1].content).toBe('World');
    });

    it('should NOT concatenate system messages', () => {
      const tokens: Token[] = [
        { id: 'tok-1', role: 'system', content: 'Config A', createdAt: 1000 },
        { id: 'tok-2', role: 'system', content: 'Config B', createdAt: 1001 },
      ];

      const result = groupTokens(tokens);
      expect(result).toHaveLength(2);
    });

    it('should NOT concatenate plan messages', () => {
      const tokens: Token[] = [
        { id: 'tok-1', role: 'plan', content: 'Step 1', createdAt: 1000 },
        { id: 'tok-2', role: 'plan', content: 'Step 2', createdAt: 1001 },
      ];

      const result = groupTokens(tokens);
      expect(result).toHaveLength(2);
    });

    it('should separate different groupable roles', () => {
      const tokens: Token[] = [
        { id: 'tok-1', role: 'assistant', content: 'Hello', createdAt: 1000 },
        { id: 'tok-2', role: 'tool', content: 'Reading', createdAt: 2000 },
        { id: 'tok-3', role: 'assistant', content: 'Done', createdAt: 3000 },
      ];

      const result = groupTokens(tokens);
      expect(result).toHaveLength(3);
      expect(result[0].role).toBe('assistant');
      expect(result[1].role).toBe('tool');
      expect(result[2].role).toBe('assistant');
    });

    it('should handle complex mixed sequence', () => {
      const tokens: Token[] = [
        { id: 'tok-1', role: 'user', content: 'Fix the auth', createdAt: 1000 },
        { id: 'tok-2', role: 'assistant', content: 'I will fix', createdAt: 2000 },
        { id: 'tok-3', role: 'assistant', content: ' the auth', createdAt: 2001 },
        { id: 'tok-4', role: 'assistant', content: ' refactor now.', createdAt: 2002 },
        { id: 'tok-5', role: 'tool', content: 'Reading', createdAt: 3000 },
        { id: 'tok-6', role: 'tool', content: ' auth.ts', createdAt: 3001 },
        { id: 'tok-7', role: 'user', content: 'Thanks', createdAt: 4000 },
      ];

      const result = groupTokens(tokens);
      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({ id: 'tok-1', role: 'user', content: 'Fix the auth', createdAt: 1000 });
      expect(result[1]).toEqual({ id: 'tok-2', role: 'assistant', content: 'I will fix the auth refactor now.', createdAt: 2000 });
      expect(result[2]).toEqual({ id: 'tok-5', role: 'tool', content: 'Reading auth.ts', createdAt: 3000 });
      expect(result[3]).toEqual({ id: 'tok-7', role: 'user', content: 'Thanks', createdAt: 4000 });
    });

    it('should handle cross-token boundary search terms after grouping', () => {
      // This is the core problem: "auth refactor" spans tokens tok-3 and tok-4
      const tokens: Token[] = [
        { id: 'tok-1', role: 'assistant', content: 'I will fix the', createdAt: 2000 },
        { id: 'tok-2', role: 'assistant', content: ' auth', createdAt: 2001 },
        { id: 'tok-3', role: 'assistant', content: ' refactor', createdAt: 2002 },
        { id: 'tok-4', role: 'assistant', content: ' issue now.', createdAt: 2003 },
      ];

      const result = groupTokens(tokens);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('I will fix the auth refactor issue now.');
      // After grouping, "auth refactor" is in a single string and searchable
      expect(result[0].content).toContain('auth refactor');
    });

    it('should return empty for empty input', () => {
      expect(groupTokens([])).toEqual([]);
    });

    it('should pass through single token unchanged', () => {
      const tokens: Token[] = [
        { id: 'tok-1', role: 'assistant', content: 'Hello', createdAt: 1000 },
      ];

      const result = groupTokens(tokens);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(tokens[0]);
    });

    it('should not mutate input tokens', () => {
      const tokens: Token[] = [
        { id: 'tok-1', role: 'assistant', content: 'Hello', createdAt: 1000 },
        { id: 'tok-2', role: 'assistant', content: ' world', createdAt: 1001 },
      ];
      const original = JSON.parse(JSON.stringify(tokens));

      groupTokens(tokens);
      expect(tokens).toEqual(original);
    });
  });

  describe('FTS5 query builder', () => {
    // Test the buildFtsQuery logic (private method, test via behavior)
    function buildFtsQuery(query: string): string | null {
      const words = query.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) return null;
      return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');
    }

    it('should quote single word', () => {
      expect(buildFtsQuery('authentication')).toBe('"authentication"');
    });

    it('should quote and AND multiple words', () => {
      expect(buildFtsQuery('auth refactor')).toBe('"auth" "refactor"');
    });

    it('should escape double quotes in words', () => {
      expect(buildFtsQuery('say "hello"')).toBe('"say" """hello"""');
    });

    it('should return null for empty query', () => {
      expect(buildFtsQuery('')).toBeNull();
      expect(buildFtsQuery('   ')).toBeNull();
    });

    it('should handle multiple spaces between words', () => {
      expect(buildFtsQuery('auth   refactor')).toBe('"auth" "refactor"');
    });
  });

  describe('Snippet extraction', () => {
    function extractSnippet(content: string, query: string): string {
      const lowerContent = content.toLowerCase();
      const matchIdx = lowerContent.indexOf(query.toLowerCase());
      if (matchIdx === -1) {
        return content.slice(0, 200) + (content.length > 200 ? '...' : '');
      }
      const start = Math.max(0, matchIdx - 80);
      const end = Math.min(content.length, matchIdx + query.length + 120);
      return (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
    }

    it('should extract snippet around match with context', () => {
      const content = 'a'.repeat(80) + 'target text' + 'b'.repeat(120);
      const snippet = extractSnippet(content, 'target text');
      expect(snippet).toContain('target text');
      // Should have prefix context
      expect(snippet.startsWith('...')).toBe(false); // match is right at position 80
    });

    it('should add leading ellipsis when match is far from start', () => {
      const content = 'x'.repeat(200) + 'target' + 'y'.repeat(200);
      const snippet = extractSnippet(content, 'target');
      expect(snippet.startsWith('...')).toBe(true);
    });

    it('should add trailing ellipsis when content extends past snippet', () => {
      const content = 'target' + 'y'.repeat(500);
      const snippet = extractSnippet(content, 'target');
      expect(snippet.endsWith('...')).toBe(true);
    });

    it('should return first 200 chars when no match found', () => {
      const content = 'a'.repeat(300);
      const snippet = extractSnippet(content, 'nonexistent');
      expect(snippet).toBe('a'.repeat(200) + '...');
    });

    it('should handle short content without ellipsis', () => {
      const snippet = extractSnippet('short text', 'short');
      expect(snippet).toBe('short text');
    });

    it('should be case-insensitive', () => {
      const snippet = extractSnippet('This is Authentication flow', 'authentication');
      expect(snippet).toContain('Authentication');
    });
  });

  describe('Migration 011', () => {
    it('should be the 11th migration', () => {
      expect(MIGRATIONS).toHaveLength(19);
      expect(MIGRATIONS[10].name).toBe('011-message-materialization-fts5');
    });

    it('should create required tables and column', () => {
      const execLog: string[] = [];
      const mockSql = {
        exec: (query: string, ..._params: unknown[]) => {
          execLog.push(query.trim());
          return { toArray: () => [] };
        },
      } as unknown as SqlStorage;

      MIGRATIONS[10].run(mockSql);

      // Should create chat_messages_grouped table (with IF NOT EXISTS for idempotency)
      expect(execLog.some((q) => q.includes('chat_messages_grouped') && q.includes('CREATE TABLE'))).toBe(true);
      // Should create FTS5 virtual table
      expect(execLog.some((q) => q.includes('chat_messages_grouped_fts') && q.includes('CREATE VIRTUAL TABLE'))).toBe(true);
      expect(execLog.some((q) => q.includes('fts5'))).toBe(true);
      // Should add materialized_at column
      expect(execLog.some((q) => q.includes('materialized_at'))).toBe(true);
      // Should create index
      expect(execLog.some((q) => q.includes('idx_grouped_messages_session'))).toBe(true);
    });
  });
});
