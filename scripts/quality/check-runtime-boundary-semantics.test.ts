import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  auditRuntimeBoundarySemantics,
  computeExitCode,
  isBlockingForScope,
  parseSemanticEvidence,
} from './check-runtime-boundary-semantics';

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-runtime-semantics-'));
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

describe('runtime-boundary semantic checks', () => {
  it('flags only unvalidated DO/D1 row narrowing and blind external payload narrowing', () => {
    const root = fixtureRepo({
      'apps/api/src/bad.ts': `
        type Row = { id: string };
        async function badRows(storage: { sql: { exec(sql: string): { toArray(): unknown[] } } }) {
          const rows = storage.sql.exec('select id from tasks').toArray() as Row[];
          return rows;
        }
        async function badPayload(request: Request) {
          const body = await request.json() as { name: string };
          const broad = await request.json() as Record<string, unknown>;
          return { body, broad };
        }
      `,
    });
    expect(auditRuntimeBoundarySemantics(root)).toMatchObject([
      { rule: 'unvalidated-row-narrowing', file: 'apps/api/src/bad.ts', line: 4 },
      { rule: 'blind-external-payload-narrowing', file: 'apps/api/src/bad.ts', line: 8 },
      { rule: 'blind-external-payload-narrowing', file: 'apps/api/src/bad.ts', line: 9 },
    ]);
  });

  it('tracks one-hop boundary variables and accepts an explicit named runtime guard', () => {
    const root = fixtureRepo({
      'apps/api/src/one-hop.ts': `
        type Row = { id: string };
        declare function isRow(value: unknown): value is Row;
        async function check(storage: { sql: { exec(sql: string): { toArray(): unknown[] } } }, request: Request) {
          const unsafeRow = storage.sql.exec('select id').toArray()[0];
          const finding = unsafeRow as Row;
          const payload = await request.json();
          if (!isRow(payload)) throw new Error('invalid');
          const safe = payload as Row;
          return { finding, safe };
        }
      `,
    });
    expect(auditRuntimeBoundarySemantics(root)).toMatchObject([
      { rule: 'unvalidated-row-narrowing', file: 'apps/api/src/one-hop.ts', line: 6 },
    ]);
  });

  it('includes untracked source in the advisory repository audit', () => {
    const root = fixtureRepo({
      'apps/api/src/tracked.ts': 'export const tracked = true;',
    });
    writeFileSync(
      join(root, 'apps/api/src/untracked.ts'),
      `type Body = { name: string };\nexport async function read(request: Request) { return await request.json() as Body; }`
    );

    expect(auditRuntimeBoundarySemantics(root)).toMatchObject([
      {
        rule: 'blind-external-payload-narrowing',
        file: 'apps/api/src/untracked.ts',
      },
    ]);
  });

  it('treats schemas, guards, sanctioned helpers, env casts, DO stubs, and RPC boundary casts as safe/low-noise', () => {
    const root = fixtureRepo({
      'apps/api/src/good.ts': `
        import { parseWithSchema, expectJsonRecord, readResponseJson } from './lib/runtime-validation';
        type Row = { id: string };
        type Env = { DATABASE: unknown };
        type Rpc = { run(): Promise<void> };
        declare const schema: unknown;
        async function good(storage: { sql: { exec(sql: string): { toArray(): unknown[] } } }, request: Request, response: Response, env: unknown, stub: unknown) {
          const rawRows = storage.sql.exec('select id from tasks').toArray();
          const rows = rawRows.map((row) => parseWithSchema(schema as never, row, 'row')) as Row[];
          const raw = await request.json();
          const body = expectJsonRecord(raw, 'request');
          const parsed = await readResponseJson(response, schema as never, 'response');
          const workerEnv = env as unknown as Env;
          const rpc = stub as unknown as Rpc;
          return { rows, body, parsed, workerEnv, rpc };
        }
      `,
    });
    expect(auditRuntimeBoundarySemantics(root)).toEqual([]);
  });
});

// Regression coverage for evidence-driven blocking promotion (2026-08-11
// ai-slop debt burn-down): scripts/quality/runtime-boundary-semantic-evidence.json
// now drives whether a scope's findings fail the run WITHOUT requiring the
// caller to pass --fail-on-findings. These tests prove the exit-code decision
// end-to-end using a fixture repo with a real violation, and are
// discriminating: they fail if the evidence-driven blocking wiring is removed
// (verified by temporarily reverting computeExitCode to `shouldFail ? 1 : 0`
// unconditionally and confirming the "no findings" case would then wrongly
// report 1 — the length>0 guard is load-bearing).
describe('runtime-boundary semantic evidence-driven blocking', () => {
  it('parses valid evidence and rejects malformed evidence', () => {
    expect(parseSemanticEvidence('{"scope":"apps/api/src","blockingEnabled":true}')).toEqual({
      scope: 'apps/api/src',
      blockingEnabled: true,
    });
    expect(() => parseSemanticEvidence('not json')).toThrow(
      /Invalid runtime-boundary semantic evidence/
    );
    expect(() => parseSemanticEvidence('{"scope":"apps/api/src"}')).toThrow(
      /Invalid runtime-boundary semantic evidence/
    );
    expect(() => parseSemanticEvidence('{"scope":"","blockingEnabled":true}')).toThrow(
      /Invalid runtime-boundary semantic evidence/
    );
    expect(() => parseSemanticEvidence('{"blockingEnabled":true}')).toThrow(
      /Invalid runtime-boundary semantic evidence/
    );
  });

  it('is blocking only when both blockingEnabled is true AND the scope matches exactly', () => {
    expect(
      isBlockingForScope({ scope: 'apps/api/src', blockingEnabled: true }, 'apps/api/src')
    ).toBe(true);
    expect(
      isBlockingForScope({ scope: 'apps/api/src', blockingEnabled: false }, 'apps/api/src')
    ).toBe(false);
    expect(
      isBlockingForScope({ scope: 'apps/web/src', blockingEnabled: true }, 'apps/api/src')
    ).toBe(false);
  });

  it('computes a nonzero exit code for a real violation when the evidence marks the scope blocking', () => {
    const root = fixtureRepo({
      'apps/api/src/violation.ts': `
        type Row = { id: string };
        async function badRow(storage: { sql: { exec(sql: string): { toArray(): unknown[] } } }) {
          const rows = storage.sql.exec('select id from tasks').toArray() as Row[];
          return rows;
        }
      `,
    });
    const findings = auditRuntimeBoundarySemantics(root, 'apps/api/src');
    expect(findings.length).toBeGreaterThan(0); // sanity: the fixture really does violate

    const blockingEvidence = { scope: 'apps/api/src', blockingEnabled: true };
    const shouldFailBlocking = isBlockingForScope(blockingEvidence, 'apps/api/src');
    expect(computeExitCode(findings.length, shouldFailBlocking)).toBe(1);

    // Discriminating controls: the same violation must NOT fail when blocking
    // isn't enabled, or when it's enabled for a different scope.
    const advisoryEvidence = { scope: 'apps/api/src', blockingEnabled: false };
    expect(
      computeExitCode(findings.length, isBlockingForScope(advisoryEvidence, 'apps/api/src'))
    ).toBe(0);
    const otherScopeEvidence = { scope: 'apps/web/src', blockingEnabled: true };
    expect(
      computeExitCode(findings.length, isBlockingForScope(otherScopeEvidence, 'apps/api/src'))
    ).toBe(0);
  });

  it('never fails when there are no findings, even with blocking enabled for the matching scope', () => {
    const root = fixtureRepo({
      'apps/api/src/clean.ts': 'export const tracked = true;',
    });
    const findings = auditRuntimeBoundarySemantics(root, 'apps/api/src');
    expect(findings).toEqual([]);

    const blockingEvidence = { scope: 'apps/api/src', blockingEnabled: true };
    const shouldFail = isBlockingForScope(blockingEvidence, 'apps/api/src');
    expect(computeExitCode(findings.length, shouldFail)).toBe(0);
  });
});
