import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  auditTypeBoundaries,
  compareBlockingCounts,
  loadBaseline,
  parseBoundaryBaseline,
} from './check-type-boundaries';

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-type-boundary-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    execFileSync('mkdir', ['-p', full.split('/').slice(0, -1).join('/')], { cwd: root });
    writeFileSync(full, content);
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixtures'], { cwd: root });
  return root;
}

describe('type-boundary ratchet audit', () => {
  it('counts blocking and report-only classes while excluding JSON.parse as unknown', () => {
    const root = fixtureRepo({
      'src/a.ts': `
        function isRecord(value: unknown): value is Record<string, unknown> {
          return typeof value === 'object' && value !== null && !Array.isArray(value);
        }
        async function route(c: { req: { json<T>(): Promise<T> } }) {
          const body = await c.req.json<{ name: string }>();
          const parsed = JSON.parse('{}') as { ok: boolean };
          const unknownOnly = JSON.parse('{}') as unknown;
          const broad = body as Record<string, unknown>;
          const double = broad as unknown as { x: string };
          const unsafe = navigator as any;
          return { parsed, unknownOnly, double, unsafe };
        }
      `,
    });
    const result = auditTypeBoundaries(root);
    expect(result.blockingCounts).toEqual({
      'as-any': 1,
      'hono-req-json-generic': 1,
      'typed-json-parse': 1,
      'local-record-guard': 1,
    });
    expect(result.reportOnlyCounts).toEqual({
      'record-string-unknown': 1,
      'unknown-double-assertion': 1,
    });
  });

  it('proves N to N+1 fails by comparing current count to a lower baseline', () => {
    const root = fixtureRepo({
      'src/a.ts': `const unsafe = value as any;`,
    });
    const result = auditTypeBoundaries(root);
    expect(
      compareBlockingCounts(result.blockingCounts, {
        'as-any': 0,
        'hono-req-json-generic': 0,
        'typed-json-parse': 0,
        'local-record-guard': 0,
      })
    ).toEqual([{ class: 'as-any', allowed: 0, current: 1 }]);
  });

  it('moves and splits pass because only net counts are compared', () => {
    const moved = fixtureRepo({
      'src/a.ts': `const unsafe = value as any;`,
      'src/b.ts': `const parsed = JSON.parse('{}') as { ok: boolean };`,
    });
    const split = fixtureRepo({
      'src/moved/one.ts': `const unsafe = value as any;`,
      'src/moved/two.ts': `const parsed = JSON.parse('{}') as { ok: boolean };`,
    });
    expect(auditTypeBoundaries(split).blockingCounts).toEqual(
      auditTypeBoundaries(moved).blockingCounts
    );
    expect(
      compareBlockingCounts(auditTypeBoundaries(split).blockingCounts, {
        'as-any': 1,
        'hono-req-json-generic': 0,
        'typed-json-parse': 1,
        'local-record-guard': 0,
      })
    ).toEqual([]);
  });

  it('decreases pass and repeated output is identical', () => {
    const root = fixtureRepo({
      'src/a.ts': `const parsed = JSON.parse('{}') as unknown;`,
    });
    const first = auditTypeBoundaries(root);
    const second = auditTypeBoundaries(root);
    expect(first.blockingCounts).toEqual({
      'as-any': 0,
      'hono-req-json-generic': 0,
      'typed-json-parse': 0,
      'local-record-guard': 0,
    });
    expect(second).toEqual(first);
    expect(
      compareBlockingCounts(first.blockingCounts, {
        'as-any': 1,
        'hono-req-json-generic': 1,
        'typed-json-parse': 1,
        'local-record-guard': 1,
      })
    ).toEqual([]);
  });

  it('includes untracked source so local checks cannot miss newly generated debt', () => {
    const root = fixtureRepo({ 'src/tracked.ts': 'export const tracked = true;' });
    writeFileSync(join(root, 'src/untracked.ts'), 'export const unsafe = value as any;');

    expect(auditTypeBoundaries(root).blockingCounts['as-any']).toBe(1);
  });

  it('fails closed when the baseline is missing or structurally incomplete', () => {
    expect(() => loadBaseline(join(tmpdir(), 'missing-sam-type-boundary-baseline.json'))).toThrow();
    expect(() =>
      parseBoundaryBaseline(
        JSON.stringify({
          metadata: {
            owner: 'quality',
            backlog: 'task',
            review: 'review',
            blockingClasses: [],
            reportOnlyClasses: [],
          },
          counts: {},
          reportOnlyCounts: {},
        })
      )
    ).toThrow('Invalid type-boundary baseline');
  });

  it('matches known function and arrow record guards, including array-accepting variants', () => {
    const root = fixtureRepo({
      'src/guards.ts': `
        function isRecord(value: unknown): value is Record<string, unknown> {
          return typeof value === 'object' && value !== null;
        }
        const isObject = (candidate: unknown): candidate is object =>
          typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
        function isRecordWithSemantics(value: unknown): value is Record<string, unknown> {
          return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
        }
      `,
    });
    expect(auditTypeBoundaries(root).blockingCounts['local-record-guard']).toBe(2);
  });
});
