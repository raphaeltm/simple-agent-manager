import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertWorkspaceTestSurfaces,
  findWorkspaceTestSurfaceFindings,
  type RequiredWorkspaceScripts,
} from './check-workspace-test-surfaces';

const temporaryRoots: string[] = [];
const NO_SPECIALIZED_REQUIREMENTS: RequiredWorkspaceScripts[] = [];

function createFixture(
  packages: Array<{
    path: string;
    name: string;
    scripts?: Record<string, string>;
    testFile?: string;
  }>
): string {
  const root = mkdtempSync(join(tmpdir(), 'workspace-test-surfaces-'));
  temporaryRoots.push(root);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

  for (const workspace of packages) {
    const workspaceRoot = join(root, workspace.path);
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: workspace.name, scripts: workspace.scripts ?? {} })
    );
    if (workspace.testFile) {
      const testPath = join(workspaceRoot, workspace.testFile);
      mkdirSync(dirname(testPath), { recursive: true });
      writeFileSync(testPath, "import { it } from 'vitest';\nit('runs', () => {});\n");
    }
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace test surface guard', () => {
  it('fails visibly when a tested workspace omits its coverage script', () => {
    const root = createFixture([
      {
        path: 'packages/covered',
        name: '@fixture/covered',
        scripts: { test: 'vitest run', 'test:coverage': 'vitest run --coverage' },
        testFile: 'tests/covered.test.ts',
      },
      {
        path: 'packages/omitted',
        name: '@fixture/omitted',
        scripts: { test: 'vitest run' },
        testFile: 'tests/omitted.test.ts',
      },
    ]);

    expect(() => assertWorkspaceTestSurfaces(root, NO_SPECIALIZED_REQUIREMENTS)).toThrow(
      '@fixture/omitted (packages/omitted): missing or invalid test:coverage'
    );
  });

  it.each(['true', ':', 'exit 0', 'echo skipped'])(
    'rejects placeholder coverage command %s',
    (command) => {
      const root = createFixture([
        {
          path: 'packages/placeholder',
          name: '@fixture/placeholder',
          scripts: { test: 'vitest run', 'test:coverage': command },
          testFile: 'tests/placeholder.test.ts',
        },
      ]);

      expect(() => assertWorkspaceTestSurfaces(root, NO_SPECIALIZED_REQUIREMENTS)).toThrow(
        '@fixture/placeholder (packages/placeholder): missing or invalid test:coverage'
      );
    }
  );

  it('detects a package with test files even when both scripts were omitted', () => {
    const root = createFixture([
      {
        path: 'packages/no-scripts',
        name: '@fixture/no-scripts',
        testFile: '__tests__/component.spec.tsx',
      },
    ]);

    expect(findWorkspaceTestSurfaceFindings(root, NO_SPECIALIZED_REQUIREMENTS)).toEqual([
      {
        workspace: 'packages/no-scripts',
        packageName: '@fixture/no-scripts',
        invalidScripts: ['test', 'test:coverage'],
      },
    ]);
  });

  it('passes when every tested workspace exposes both commands', () => {
    const root = createFixture([
      {
        path: 'packages/complete',
        name: '@fixture/complete',
        scripts: { test: 'vitest run', 'test:coverage': 'vitest run --coverage' },
        testFile: 'tests/complete.test.ts',
      },
      { path: 'packages/no-tests', name: '@fixture/no-tests' },
    ]);

    expect(() => assertWorkspaceTestSurfaces(root, NO_SPECIALIZED_REQUIREMENTS)).not.toThrow();
  });

  it('fails when a specialized browser package omits a required script', () => {
    const root = createFixture([
      {
        path: 'packages/specialized',
        name: '@fixture/specialized',
        scripts: { 'test:browser': 'playwright test' },
      },
    ]);

    expect(() =>
      assertWorkspaceTestSurfaces(root, [
        {
          workspace: 'packages/specialized',
          packageName: '@fixture/specialized',
          scripts: ['build-browser', 'test:browser'],
        },
      ])
    ).toThrow('@fixture/specialized (packages/specialized): missing or invalid build-browser');
  });

  it('fails when a required specialized package is absent', () => {
    const root = createFixture([]);

    expect(() =>
      assertWorkspaceTestSurfaces(root, [
        {
          workspace: 'packages/absent',
          packageName: '@fixture/absent',
          scripts: ['test:browser'],
        },
      ])
    ).toThrow('missing or invalid pnpm workspace membership');
  });

  it('fails when a specialized package path leaves the pnpm workspace graph', () => {
    const root = createFixture([]);
    const workspaceRoot = join(root, 'apps/www');
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({
        name: '@fixture/www',
        scripts: { 'test:browser': 'playwright test' },
      })
    );

    expect(() =>
      assertWorkspaceTestSurfaces(root, [
        {
          workspace: 'apps/www',
          packageName: '@fixture/www',
          scripts: ['test:browser'],
        },
      ])
    ).toThrow('@fixture/www (apps/www): missing or invalid pnpm workspace membership');
  });

  it('fails when a specialized package manifest has the wrong package name', () => {
    const root = createFixture([
      {
        path: 'packages/specialized',
        name: '@fixture/renamed',
        scripts: { 'test:browser': 'playwright test' },
      },
    ]);

    expect(() =>
      assertWorkspaceTestSurfaces(root, [
        {
          workspace: 'packages/specialized',
          packageName: '@fixture/expected',
          scripts: ['test:browser'],
        },
      ])
    ).toThrow('missing or invalid package name @fixture/expected');
  });

  it('passes against the checked-in workspace graph', () => {
    expect(() => assertWorkspaceTestSurfaces(resolve(import.meta.dirname, '../..'))).not.toThrow();
  });
});
