import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/quality/check-file-sizes.ts');
const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'file-size-check-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'apps/api/src'), { recursive: true });
  mkdirSync(join(dir, 'packages/example/tests'), { recursive: true });
  mkdirSync(join(dir, 'scripts/quality'), { recursive: true });
  return dir;
}

function lineFile(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `export const value${index} = ${index};`).join(
    '\n'
  );
}

function runCheck(cwd: string, ...args: string[]): string {
  return execFileSync('npx', ['tsx', SCRIPT, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, QUALITY_FILE_SIZE_ROOT: cwd },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('file size quality check', () => {
  it('keeps the default mode non-regressed by failing new oversized source files', () => {
    const dir = makeWorkspace();
    writeFileSync(join(dir, 'apps/api/src/new-large-file.ts'), lineFile(801));

    expect(() => runCheck(dir)).toThrow(/new-large-file\.ts: 801 lines/);
  });

  it('reports oversized tests without failing report mode', () => {
    const dir = makeWorkspace();
    writeFileSync(join(dir, 'packages/example/tests/large.test.ts'), lineFile(801));

    const output = runCheck(dir, '--report-debt');

    expect(output).toContain(
      'File size debt report: 1 known oversized source/test files above 800 lines.'
    );
    expect(output).toContain('packages/example/tests/large.test.ts: 801 lines');
    expect(output).toContain('oversized test file; exempt from hard source gate');
  });
});
