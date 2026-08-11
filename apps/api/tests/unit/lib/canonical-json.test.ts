/**
 * Unit tests for canonicalJson — deterministic, key-sorted JSON serialization
 * used for signing/hashing (e.g. webhook trigger payloads, trigger templates).
 *
 * canonicalize() replaced a local `isRecord` type guard with the shared
 * `maybeJsonRecord` runtime-boundary helper (.claude/rules/51). These tests
 * assert byte-identical output for nested arrays/objects — a parse-don't-grep
 * requirement for structured-output code (.claude/rules/02).
 */
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../../src/lib/canonical-json';

describe('canonicalJson', () => {
  it('produces byte-identical output regardless of input key order', () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('recursively sorts keys of nested objects', () => {
    expect(
      canonicalJson({
        z: { y: 1, x: 2 },
        a: 1,
      })
    ).toBe('{"a":1,"z":{"x":2,"y":1}}');
  });

  it('recursively canonicalizes objects nested inside arrays, preserving array order', () => {
    const result = canonicalJson({
      items: [
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ],
    });
    expect(result).toBe('{"items":[{"a":2,"b":1},{"c":4,"d":3}]}');
  });

  it('preserves array element order (arrays are never sorted, only object keys)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ list: ['z', 'a', 'm'] })).toBe('{"list":["z","a","m"]}');
  });

  it('canonicalizes deeply nested mixed arrays/objects byte-identically regardless of source key order', () => {
    const shapeA = {
      workspace: { id: 'ws-1', tags: ['b', 'a'] },
      events: [
        { type: 'created', meta: { user: 'u1', ts: 2 } },
        { type: 'updated', meta: { ts: 3, user: 'u2' } },
      ],
    };
    const shapeB = {
      events: [
        { meta: { ts: 2, user: 'u1' }, type: 'created' },
        { meta: { user: 'u2', ts: 3 }, type: 'updated' },
      ],
      workspace: { tags: ['b', 'a'], id: 'ws-1' },
    };
    const canonicalA = canonicalJson(shapeA);
    const canonicalB = canonicalJson(shapeB);
    expect(canonicalA).toBe(canonicalB);
    expect(canonicalA).toBe(
      '{"events":[{"meta":{"ts":2,"user":"u1"},"type":"created"},{"meta":{"ts":3,"user":"u2"},"type":"updated"}],"workspace":{"id":"ws-1","tags":["b","a"]}}'
    );
  });

  it('sorts keys using en-US locale comparison (not raw code-unit order)', () => {
    expect(canonicalJson({ B: 1, a: 2 })).toBe('{"a":2,"B":1}');
  });

  it('passes through primitives unchanged', () => {
    expect(canonicalJson('hello')).toBe('"hello"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(null)).toBe('null');
  });

  it('handles empty objects and empty arrays', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({ empty: {}, list: [] })).toBe('{"empty":{},"list":[]}');
  });

  it('drops undefined-valued keys the same way JSON.stringify does (no behavior change from the guard swap)', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('degrades a bare undefined value to the String() fallback (pre-existing behavior, unaffected by the guard swap)', () => {
    expect(canonicalJson(undefined)).toBe('undefined');
  });

  it('round-trips a realistic webhook trigger payload byte-identically across two differently-ordered equivalent inputs', () => {
    const payloadA = {
      triggerId: 'trig-1',
      projectId: 'proj-1',
      firedAt: '2026-08-10T00:00:00.000Z',
      context: { branch: 'main', commitSha: 'abc123', actor: { id: 'u1', name: 'Ada' } },
      labels: ['ci', 'auto'],
    };
    const payloadB = {
      labels: ['ci', 'auto'],
      context: { actor: { name: 'Ada', id: 'u1' }, commitSha: 'abc123', branch: 'main' },
      firedAt: '2026-08-10T00:00:00.000Z',
      projectId: 'proj-1',
      triggerId: 'trig-1',
    };
    expect(canonicalJson(payloadA)).toBe(canonicalJson(payloadB));
  });
});
