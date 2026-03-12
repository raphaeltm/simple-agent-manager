/**
 * Behavioral tests for safeParseJson — the function that parses tool metadata JSON.
 *
 * Tests the exported function directly from workspaces.ts.
 * The bug: using `'constructor' in parsed` instead of `Object.hasOwn(parsed, 'constructor')`
 * caused ALL valid JSON objects to be rejected (since 'constructor' is on Object.prototype).
 */
import { describe, expect, it } from 'vitest';
import { safeParseJson } from '../../../src/routes/workspaces/_helpers';

// The old buggy version for regression testing — demonstrates the bug
function safeParseJsonBuggy(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    if ('__proto__' in parsed || 'constructor' in parsed || 'prototype' in parsed) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe('safeParseJson', () => {
  describe('parses valid tool metadata JSON', () => {
    it('parses a simple object', () => {
      const result = safeParseJson('{"toolCallId":"abc","title":"Read file"}');
      expect(result).toEqual({ toolCallId: 'abc', title: 'Read file' });
    });

    it('parses an empty object', () => {
      expect(safeParseJson('{}')).toEqual({});
    });

    it('parses tool metadata with nested content', () => {
      const meta = JSON.stringify({
        toolCallId: 'tc-123',
        title: 'Edit file',
        kind: 'edit',
        status: 'completed',
        locations: [{ path: '/src/main.ts', line: 42 }],
        content: [{ type: 'diff', path: '/src/main.ts' }],
      });
      const result = safeParseJson(meta);
      expect(result).not.toBeNull();
      expect(result!.toolCallId).toBe('tc-123');
      expect(result!.title).toBe('Edit file');
      expect((result!.locations as unknown[])).toHaveLength(1);
    });

    it('parses objects with numeric and boolean values', () => {
      const result = safeParseJson('{"count":5,"active":true,"name":"test"}');
      expect(result).toEqual({ count: 5, active: true, name: 'test' });
    });
  });

  describe('rejects invalid inputs', () => {
    it('returns null for invalid JSON', () => {
      expect(safeParseJson('not json')).toBeNull();
    });

    it('returns null for arrays', () => {
      expect(safeParseJson('[1,2,3]')).toBeNull();
    });

    it('returns null for null', () => {
      expect(safeParseJson('null')).toBeNull();
    });

    it('returns null for numbers', () => {
      expect(safeParseJson('42')).toBeNull();
    });

    it('returns null for strings', () => {
      expect(safeParseJson('"hello"')).toBeNull();
    });

    it('returns null for booleans', () => {
      expect(safeParseJson('true')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(safeParseJson('')).toBeNull();
    });

    it('returns null for whitespace', () => {
      expect(safeParseJson('  ')).toBeNull();
    });
  });

  describe('blocks prototype pollution', () => {
    it('rejects objects with own __proto__ key', () => {
      // Note: JSON.parse('{"__proto__":...}') creates an own property
      expect(safeParseJson('{"__proto__":{"admin":true}}')).toBeNull();
    });

    it('rejects objects with own constructor key', () => {
      expect(safeParseJson('{"constructor":{"prototype":{"admin":true}}}')).toBeNull();
    });

    it('rejects objects with own prototype key', () => {
      expect(safeParseJson('{"prototype":{"admin":true}}')).toBeNull();
    });
  });

  describe('regression: prototype chain check bug', () => {
    it('demonstrates the bug: old version rejects ALL objects', () => {
      // The old buggy version uses `'constructor' in parsed` which checks
      // the prototype chain. Since Object.prototype.constructor exists,
      // this returns true for ALL parsed objects.
      expect(safeParseJsonBuggy('{}')).toBeNull(); // Bug: empty object rejected
      expect(safeParseJsonBuggy('{"a":1}')).toBeNull(); // Bug: normal object rejected
      expect(safeParseJsonBuggy('{"toolCallId":"tc-1"}')).toBeNull(); // Bug: tool metadata rejected
    });

    it('fixed version accepts normal objects', () => {
      // The fixed version uses Object.hasOwn which only checks own properties
      expect(safeParseJson('{}')).toEqual({});
      expect(safeParseJson('{"a":1}')).toEqual({ a: 1 });
      expect(safeParseJson('{"toolCallId":"tc-1"}')).toEqual({ toolCallId: 'tc-1' });
    });
  });
});
