import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type PackageManifest = {
  name?: string;
  scripts?: Record<string, string>;
};

export type WorkspaceTestSurfaceFinding = {
  workspace: string;
  packageName: string;
  invalidScripts: Array<'test' | 'test:coverage'>;
};

const TEST_FILE_PATTERN = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)|[^/]+_test\.go)$/;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.turbo',
  '.wrangler',
  'coverage',
  'dist',
  'node_modules',
  'storybook-static',
]);

function isRunnableScript(command: string | undefined): boolean {
  const normalized = command?.trim();
  if (!normalized) return false;
  if (/^(?:true|:|exit\s+0)$/i.test(normalized)) return false;
  if (/^(?:echo|printf)\b/i.test(normalized) && !/(?:&&|\|\||;)/.test(normalized)) return false;
  return true;
}

function parseWorkspacePatterns(workspaceSource: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;

  for (const line of workspaceSource.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line) && line.trim() !== '') break;
    if (!inPackages) continue;

    const match = line.match(/^\s+-\s+['"]?([^'"]+)['"]?\s*$/);
    if (match?.[1]) patterns.push(match[1]);
  }

  if (patterns.length === 0) {
    throw new Error('pnpm-workspace.yaml does not declare any package patterns');
  }
  return patterns;
}

function expandWorkspacePattern(root: string, pattern: string): string[] {
  if (pattern.startsWith('!')) {
    throw new Error(`unsupported negated workspace pattern: ${pattern}`);
  }
  if (!pattern.includes('*')) return [resolve(root, pattern)];
  if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
    throw new Error(`unsupported workspace pattern: ${pattern}`);
  }

  const parent = resolve(root, pattern.slice(0, -2));
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(parent, entry.name));
}

function containsTestFile(directory: string, current = directory): boolean {
  if (!existsSync(current)) return false;

  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const entryPath = resolve(current, entry.name);
    if (entry.isDirectory() && containsTestFile(directory, entryPath)) return true;
    if (entry.isFile() && TEST_FILE_PATTERN.test(relative(directory, entryPath))) return true;
  }
  return false;
}

function readManifest(manifestPath: string): PackageManifest {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
  } catch (error) {
    throw new Error(`invalid workspace manifest ${manifestPath}: ${String(error)}`);
  }
}

export function findWorkspaceTestSurfaceFindings(root: string): WorkspaceTestSurfaceFinding[] {
  const workspaceFile = resolve(root, 'pnpm-workspace.yaml');
  const workspacePatterns = parseWorkspacePatterns(readFileSync(workspaceFile, 'utf8'));
  const workspaceDirectories = workspacePatterns.flatMap((pattern) =>
    expandWorkspacePattern(root, pattern)
  );
  const findings: WorkspaceTestSurfaceFinding[] = [];

  for (const workspaceDirectory of workspaceDirectories) {
    const manifestPath = resolve(workspaceDirectory, 'package.json');
    if (!existsSync(manifestPath)) continue;

    const manifest = readManifest(manifestPath);
    const hasTests = containsTestFile(workspaceDirectory);
    const hasTestScript = isRunnableScript(manifest.scripts?.test);
    if (!hasTests && !hasTestScript) continue;

    const invalidScripts: WorkspaceTestSurfaceFinding['invalidScripts'] = [];
    if (!hasTestScript) invalidScripts.push('test');
    if (!isRunnableScript(manifest.scripts?.['test:coverage']))
      invalidScripts.push('test:coverage');
    if (invalidScripts.length === 0) continue;

    findings.push({
      workspace: relative(root, workspaceDirectory),
      packageName: manifest.name ?? relative(root, workspaceDirectory),
      invalidScripts,
    });
  }

  return findings.sort((left, right) => left.workspace.localeCompare(right.workspace));
}

export function assertWorkspaceTestSurfaces(root: string): void {
  const findings = findWorkspaceTestSurfaceFindings(root);
  if (findings.length === 0) return;

  const details = findings.map(
    (finding) =>
      `- ${finding.packageName} (${finding.workspace}): missing or placeholder ${finding.invalidScripts.join(', ')}`
  );
  throw new Error(
    [
      'Tested workspaces must expose non-placeholder test and test:coverage scripts:',
      ...details,
    ].join('\n')
  );
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    assertWorkspaceTestSurfaces(repositoryRoot);
    console.log(
      'Workspace test surfaces: all tested pnpm workspaces expose test and test:coverage'
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
