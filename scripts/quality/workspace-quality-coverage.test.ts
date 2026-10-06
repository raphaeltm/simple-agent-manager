import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

type WorkspaceInventory = {
  path: string;
  manifest: {
    name?: string;
    scripts?: Record<string, string>;
  };
  counts: Record<string, number>;
  files: string[];
};

type CoverageFailure = {
  workspace: string;
  reason: string;
};

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.astro'] as const;

function parseWorkspacePatterns(workspaceYaml: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;

  for (const line of workspaceYaml.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }

    if (inPackages && /^\S/.test(line)) {
      break;
    }

    const match = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
    if (inPackages && match) {
      patterns.push(match[1]);
    }
  }

  return patterns;
}

function expandWorkspacePattern(repoRoot: string, pattern: string): string[] {
  if (!pattern.endsWith('/*')) {
    return [pattern].filter((workspacePath) =>
      existsSync(path.join(repoRoot, workspacePath, 'package.json'))
    );
  }

  const parent = pattern.slice(0, -2);
  const absoluteParent = path.join(repoRoot, parent);
  if (!existsSync(absoluteParent)) {
    return [];
  }

  return readdirSync(absoluteParent)
    .map((entry) => path.join(parent, entry).replaceAll(path.sep, '/'))
    .filter((workspacePath) => {
      const absolutePath = path.join(repoRoot, workspacePath);
      return (
        statSync(absolutePath).isDirectory() && existsSync(path.join(absolutePath, 'package.json'))
      );
    });
}

function listTrackedSourceFiles(repoRoot: string): string[] {
  try {
    return execFileSync(
      'git',
      ['ls-files', ...SOURCE_EXTENSIONS.map((extension) => `*${extension}`)],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      }
    )
      .split('\n')
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function listFixtureSourceFiles(repoRoot: string): string[] {
  const files: string[] = [];

  function walk(relativeDirectory: string): void {
    for (const entry of readdirSync(path.join(repoRoot, relativeDirectory))) {
      const relativePath = path.join(relativeDirectory, entry).replaceAll(path.sep, '/');
      const absolutePath = path.join(repoRoot, relativePath);
      if (statSync(absolutePath).isDirectory()) {
        walk(relativePath);
      } else if (SOURCE_EXTENSIONS.some((extension) => relativePath.endsWith(extension))) {
        files.push(relativePath);
      }
    }
  }

  walk('.');
  return files.sort();
}

function inventoryWorkspaces(
  repoRoot: string,
  sourceFiles = listTrackedSourceFiles(repoRoot)
): WorkspaceInventory[] {
  const patterns = parseWorkspacePatterns(
    readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  );
  const workspacePaths = patterns
    .flatMap((pattern) => expandWorkspacePattern(repoRoot, pattern))
    .sort();

  return workspacePaths.map((workspacePath) => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, workspacePath, 'package.json'), 'utf8')
    );
    const files = sourceFiles.filter((file) => file.startsWith(`${workspacePath}/`));
    const counts = Object.fromEntries(SOURCE_EXTENSIONS.map((extension) => [extension, 0]));
    for (const file of files) {
      counts[path.extname(file)] += 1;
    }

    return {
      path: workspacePath,
      manifest,
      counts,
      files,
    };
  });
}

function validateWorkspaceCoverage(workspaces: WorkspaceInventory[]): CoverageFailure[] {
  const failures: CoverageFailure[] = [];

  for (const workspace of workspaces) {
    if (workspace.files.length === 0) {
      continue;
    }

    const scripts = workspace.manifest.scripts ?? {};
    if (!scripts.lint?.trim()) {
      failures.push({
        workspace: workspace.path,
        reason: `missing lint script for ${workspace.files.length} tracked TS/Astro file(s)`,
      });
    }

    const typeScriptFileCount = SOURCE_EXTENSIONS.filter(
      (extension) => extension !== '.astro'
    ).reduce((sum, extension) => sum + workspace.counts[extension], 0);
    const astroFileCount = workspace.counts['.astro'];
    const validationScript = scripts.typecheck ?? scripts.check ?? '';

    if (
      astroFileCount > 0 &&
      !/\*[^'"]*\.astro|\{[^}]*\bastro\b[^}]*\}|eslint\s+['"]?\.(?:['"]?\s|$)/.test(
        scripts.lint ?? ''
      )
    ) {
      failures.push({
        workspace: workspace.path,
        reason: `lint script does not include ${astroFileCount} tracked Astro template(s)`,
      });
    }

    if (
      typeScriptFileCount > 0 &&
      !/\btsc\b|\bastro\s+check\b|\bcheck-astro-templates\b/.test(validationScript)
    ) {
      failures.push({
        workspace: workspace.path,
        reason: `missing TypeScript validation for ${typeScriptFileCount} tracked TS-family file(s)`,
      });
    }

    if (
      astroFileCount > 0 &&
      !/\bastro\s+check\b|\bcheck-astro-templates\b/.test(validationScript)
    ) {
      failures.push({
        workspace: workspace.path,
        reason: `Astro templates require astro check; tsc does not validate ${astroFileCount} .astro file(s)`,
      });
    }
  }

  return failures;
}

describe('workspace quality coverage contract', () => {
  it('requires lint and type/template coverage for every pnpm workspace with tracked TS/Astro files', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const workspaces = inventoryWorkspaces(repoRoot);
    const failures = validateWorkspaceCoverage(workspaces);

    const summary = workspaces
      .filter((workspace) => workspace.files.length > 0)
      .map((workspace) => `${workspace.path}: ${workspace.files.length}`)
      .join(', ');

    expect(failures, `Workspace source inventory: ${summary}`).toEqual([]);
  });

  it('fails clearly when a new TypeScript workspace has no lint script', () => {
    const fixtureRoot = path.join(
      import.meta.dirname,
      'fixtures/workspace-quality-coverage/missing-lint'
    );
    const failures = validateWorkspaceCoverage(
      inventoryWorkspaces(fixtureRoot, listFixtureSourceFiles(fixtureRoot))
    );

    expect(failures).toContainEqual({
      workspace: 'apps/uncovered',
      reason: 'missing lint script for 1 tracked TS/Astro file(s)',
    });
  });

  it('requires astro check rather than tsc-only validation for Astro templates', () => {
    const fixtureRoot = path.join(
      import.meta.dirname,
      'fixtures/workspace-quality-coverage/astro-tsc-only'
    );
    const failures = validateWorkspaceCoverage(
      inventoryWorkspaces(fixtureRoot, listFixtureSourceFiles(fixtureRoot))
    );

    expect(failures).toContainEqual({
      workspace: 'apps/www',
      reason: 'Astro templates require astro check; tsc does not validate 1 .astro file(s)',
    });
    expect(failures).toContainEqual({
      workspace: 'apps/www',
      reason: 'lint script does not include 1 tracked Astro template(s)',
    });
  });

  it('accepts a covered TypeScript workspace fixture', () => {
    const fixtureRoot = path.join(
      import.meta.dirname,
      'fixtures/workspace-quality-coverage/covered'
    );
    const failures = validateWorkspaceCoverage(
      inventoryWorkspaces(fixtureRoot, listFixtureSourceFiles(fixtureRoot))
    );

    expect(failures).toEqual([]);
  });
});
