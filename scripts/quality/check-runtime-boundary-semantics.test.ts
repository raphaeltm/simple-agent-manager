import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { auditRuntimeBoundarySemantics } from './check-runtime-boundary-semantics';

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
