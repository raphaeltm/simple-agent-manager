import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBindings } from './node-pool-boundary/bindings';
import { listRepositorySourceFiles, parseSourceFile } from './node-pool-boundary/source-files';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('node-pool scanner source boundaries', () => {
  it('lists tracked and untracked source files without executing Git from PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'node-pool-source-files-'));
    temporaryDirectories.push(root);
    execFileSync('/usr/bin/git', ['init', '--quiet'], { cwd: root });
    const sourceRoot = join(root, 'apps/api/src');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, 'tracked.ts'), 'export const tracked = true;');
    execFileSync('/usr/bin/git', ['add', '.'], { cwd: root });
    writeFileSync(join(sourceRoot, 'untracked.tsx'), 'export const untracked = true;');
    writeFileSync(join(sourceRoot, 'types.d.ts'), 'declare const ignored: true;');
    writeFileSync(join(sourceRoot, 'ignored.ts'), 'export const ignored = true;');
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
    const marker = join(root, 'untrusted-git-executed');
    writeFileSync(join(root, 'git'), '#!/bin/sh\nprintf executed > untrusted-git-executed\n', {
      mode: 0o755,
    });
    vi.stubEnv('PATH', root);

    const files = listRepositorySourceFiles(root);
    expect(files).toEqual(
      expect.arrayContaining([
        { filePath: 'apps/api/src/tracked.ts', source: 'export const tracked = true;' },
        { filePath: 'apps/api/src/untracked.tsx', source: 'export const untracked = true;' },
      ])
    );
    expect(files).toHaveLength(2);
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ['const', 'vmSize'],
    ['let', undefined],
    ['var', undefined],
  ] as const)('resolves only immutable %s initializers as static keys', (kind, expected) => {
    const source = parseSourceFile({
      filePath: 'fixture.ts',
      source: `${kind} key = 'vmSize'; node[key];`,
    });
    const bindings = createBindings(source);
    const statement = source.statements[1];
    expect(ts.isExpressionStatement(statement)).toBe(true);
    if (!ts.isExpressionStatement(statement)) throw new Error('Missing fixture expression');
    const expression = statement.expression;
    expect(ts.isElementAccessExpression(expression)).toBe(true);
    if (!ts.isElementAccessExpression(expression)) throw new Error('Missing fixture access');

    expect(bindings.stringValue(expression.argumentExpression)).toBe(expected);
  });
});
