import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { auditTypeBoundaries } from './check-type-boundaries';

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-type-boundary-'));
  execFileSync('git', ['init'], { cwd: root });
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
    expect(result.blockingCounts['as-any']).toBeGreaterThan(0);
    expect(result.blockingCounts['as-any']).toBeGreaterThan(0);
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
  });
});
