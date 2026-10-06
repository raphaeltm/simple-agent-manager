import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type PackageManifest = {
  name?: string;
  scripts?: Record<string, string>;
};

export type WorkspaceTestSurfaceFinding = {
  workspace: string;
  packageName: string;
  invalidScripts: string[];
};

export type RequiredWorkspaceScripts = {
  workspace: string;
  packageName: string;
  scripts: string[];
};

export const REQUIRED_WORKSPACE_SCRIPTS: RequiredWorkspaceScripts[] = [
  {
    workspace: 'packages/ui',
    packageName: '@simple-agent-manager/ui',
    scripts: ['build-storybook', 'test:storybook'],
  },
  {
    workspace: 'apps/www',
    packageName: '@simple-agent-manager/www',
    scripts: ['check:links', 'test:browser'],
  },
];

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

function hasJsonObjectShape(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

    const entry = parseWorkspaceEntry(line);
    if (entry) patterns.push(entry);
  }

  if (patterns.length === 0) {
    throw new Error('pnpm-workspace.yaml does not declare any package patterns');
  }
  return patterns;
}

function parseWorkspaceEntry(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('-')) return undefined;

  const value = trimmed.slice(1).trim();
  const quote = value.at(0);
  if ((quote === "'" || quote === '"') && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value || undefined;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`invalid workspace manifest ${manifestPath}: ${String(error)}`);
  }

  if (!hasJsonObjectShape(parsed)) {
    throw new Error(`invalid workspace manifest ${manifestPath}: expected object`);
  }

  const name = Reflect.get(parsed, 'name');
  if (name !== undefined && typeof name !== 'string') {
    throw new Error(`invalid workspace manifest ${manifestPath}: name must be a string`);
  }

  const rawScripts = Reflect.get(parsed, 'scripts');
  if (rawScripts !== undefined && !hasJsonObjectShape(rawScripts)) {
    throw new Error(`invalid workspace manifest ${manifestPath}: scripts must be an object`);
  }

  const scripts: Record<string, string> | undefined = rawScripts ? {} : undefined;
  if (scripts && hasJsonObjectShape(rawScripts)) {
    for (const [scriptName, command] of Object.entries(rawScripts)) {
      if (typeof command !== 'string') {
        throw new Error(
          `invalid workspace manifest ${manifestPath}: script ${scriptName} must be a string`
        );
      }
      scripts[scriptName] = command;
    }
  }

  return { name, scripts };
}

function findTestedWorkspaceFindings(
  root: string,
  workspaceDirectories: string[]
): WorkspaceTestSurfaceFinding[] {
  const findings: WorkspaceTestSurfaceFinding[] = [];

  for (const workspaceDirectory of workspaceDirectories) {
    const manifestPath = resolve(workspaceDirectory, 'package.json');
    if (!existsSync(manifestPath)) continue;

    const manifest = readManifest(manifestPath);
    const hasTests = containsTestFile(workspaceDirectory);
    const hasTestScript = isRunnableScript(manifest.scripts?.test);
    if (!hasTests && !hasTestScript) continue;

    const invalidScripts = ['test', 'test:coverage'].filter((script) =>
      script === 'test' ? !hasTestScript : !isRunnableScript(manifest.scripts?.[script])
    );
    if (invalidScripts.length > 0) {
      findings.push({
        workspace: relative(root, workspaceDirectory),
        packageName: manifest.name ?? relative(root, workspaceDirectory),
        invalidScripts,
      });
    }
  }

  return findings;
}

function findRequiredWorkspaceFinding(
  root: string,
  workspaceDirectories: string[],
  requirement: RequiredWorkspaceScripts
): WorkspaceTestSurfaceFinding | undefined {
  const workspaceDirectory = resolve(root, requirement.workspace);
  const manifestPath = resolve(workspaceDirectory, 'package.json');
  const manifest = existsSync(manifestPath) ? readManifest(manifestPath) : undefined;
  const invalidScripts = requirement.scripts.filter(
    (script) => !isRunnableScript(manifest?.scripts?.[script])
  );

  if (!workspaceDirectories.includes(workspaceDirectory)) {
    invalidScripts.unshift('pnpm workspace membership');
  }
  if (manifest?.name !== requirement.packageName) {
    invalidScripts.push(`package name ${requirement.packageName}`);
  }
  if (invalidScripts.length === 0) return undefined;

  return {
    workspace: requirement.workspace,
    packageName: manifest?.name ?? requirement.packageName,
    invalidScripts,
  };
}

function mergeFinding(
  findings: WorkspaceTestSurfaceFinding[],
  candidate: WorkspaceTestSurfaceFinding
): void {
  const existing = findings.find((finding) => finding.workspace === candidate.workspace);
  if (!existing) {
    findings.push(candidate);
    return;
  }

  const additions = candidate.invalidScripts.filter(
    (script) => !existing.invalidScripts.includes(script)
  );
  existing.invalidScripts.push(...additions);
}

export function findWorkspaceTestSurfaceFindings(
  root: string,
  requiredWorkspaceScripts: RequiredWorkspaceScripts[] = REQUIRED_WORKSPACE_SCRIPTS
): WorkspaceTestSurfaceFinding[] {
  const workspaceFile = resolve(root, 'pnpm-workspace.yaml');
  const workspacePatterns = parseWorkspacePatterns(readFileSync(workspaceFile, 'utf8'));
  const workspaceDirectories = workspacePatterns.flatMap((pattern) =>
    expandWorkspacePattern(root, pattern)
  );
  const findings = findTestedWorkspaceFindings(root, workspaceDirectories);

  for (const requirement of requiredWorkspaceScripts) {
    const finding = findRequiredWorkspaceFinding(root, workspaceDirectories, requirement);
    if (finding) mergeFinding(findings, finding);
  }

  return findings.sort((left, right) => left.workspace.localeCompare(right.workspace));
}

export function assertWorkspaceTestSurfaces(
  root: string,
  requiredWorkspaceScripts: RequiredWorkspaceScripts[] = REQUIRED_WORKSPACE_SCRIPTS
): void {
  const findings = findWorkspaceTestSurfaceFindings(root, requiredWorkspaceScripts);
  if (findings.length === 0) return;

  const details = findings.map(
    (finding) =>
      `- ${finding.packageName} (${finding.workspace}): missing or invalid ${finding.invalidScripts.join(', ')}`
  );
  throw new Error(
    ['Workspaces must expose every required non-placeholder quality script:', ...details].join('\n')
  );
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    assertWorkspaceTestSurfaces(repositoryRoot);
    console.log(
      'Workspace quality surfaces: all tested workspaces and specialized browser packages expose required scripts'
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
