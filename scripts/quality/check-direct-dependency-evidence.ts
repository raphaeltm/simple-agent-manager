import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as v from 'valibot';

export type DependencyEcosystem = 'npm' | 'go';

export interface DependencyAddition {
  ecosystem: DependencyEcosystem;
  manifestPath: string;
  name: string;
  production: boolean;
  internal: boolean;
}

export interface DependencyEvidence {
  registryUrl?: string;
  homepageUrl?: string;
  necessity?: string;
}

export interface EvidenceFile {
  npm?: Record<string, DependencyEvidence>;
  go?: Record<string, DependencyEvidence>;
}

export interface CheckResult {
  ok: boolean;
  additions: DependencyAddition[];
  errors: string[];
}

const repoRoot = posix.normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const evidencePath = join(repoRoot, 'scripts/quality/direct-dependency-evidence.json');
const urlPattern = /^https:\/\/[^\s"<>]+$/;
const goRequirePattern =
  /^\+\s*(?:require\s+)?([A-Za-z0-9_.~/-]+\.[A-Za-z0-9_.~/-]+)\s+v[^\s]+(?:\s*\/\/.*)?$/;
const DependencyEvidenceSchema = v.object({
  registryUrl: v.optional(v.string()),
  homepageUrl: v.optional(v.string()),
  necessity: v.optional(v.string()),
});
const EvidenceFileSchema = v.looseObject({
  npm: v.optional(v.record(v.string(), DependencyEvidenceSchema)),
  go: v.optional(v.record(v.string(), DependencyEvidenceSchema)),
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function normalizeRepoPath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/'));
}

function changedFileFromDiffLine(line: string): string | undefined {
  const match = /^\+\+\+ b\/(.+)$/.exec(line);
  return match?.[1] ? normalizeRepoPath(match[1]) : undefined;
}

function packageDependencySection(line: string): 'dependencies' | 'devDependencies' | undefined {
  const match = /^\s*[+-]?\s*"([^"]+)":\s*\{?\s*$/.exec(line);
  const key = match?.[1];
  if (key === 'dependencies' || key === 'devDependencies') return key;
  return undefined;
}

function npmDependencyFromAddedLine(line: string): { name: string; version: string } | undefined {
  const match = /^\+\s*"([^"]+)":\s*"([^"]+)"\s*,?\s*$/.exec(line);
  if (!match?.[1] || !match[2]) return undefined;
  return { name: match[1], version: match[2] };
}

function npmDependencyFromRemovedLine(line: string): { name: string; version: string } | undefined {
  const match = /^-\s*"([^"]+)":\s*"([^"]+)"\s*,?\s*$/.exec(line);
  if (!match?.[1] || !match[2]) return undefined;
  return { name: match[1], version: match[2] };
}

function isInternalNpmDependency(
  name: string,
  version: string,
  workspacePackageName?: string
): boolean {
  if (version.startsWith('workspace:')) return true;
  if (name.startsWith('@simple-agent-manager/')) return true;
  return workspacePackageName === name;
}

function isInternalGoDependency(name: string): boolean {
  return name.startsWith('github.com/raphaeltm/simple-agent-manager/');
}

export function extractDirectDependencyAdditions(diff: string): DependencyAddition[] {
  const additions: DependencyAddition[] = [];
  const removedDependencies = new Set<string>();
  let currentFile: string | undefined;
  let npmSection: 'dependencies' | 'devDependencies' | undefined;
  let inGoRequireBlock = false;

  for (const line of diff.split('\n')) {
    const nextFile = changedFileFromDiffLine(line);
    if (nextFile) {
      currentFile = nextFile;
      npmSection = undefined;
      inGoRequireBlock = false;
      continue;
    }

    if (!currentFile) continue;

    if (basename(currentFile) === 'package.json') {
      const section = packageDependencySection(line);
      if (section) npmSection = section;
      if (/^\s*[+-]?\s*}\s*,?\s*$/.test(line)) npmSection = undefined;

      const removedDependency = npmDependencyFromRemovedLine(line);
      if (removedDependency && npmSection) {
        removedDependencies.add(`${currentFile}\0${npmSection}\0${removedDependency.name}`);
      }

      const dependency = npmDependencyFromAddedLine(line);
      if (dependency && npmSection) {
        if (removedDependencies.has(`${currentFile}\0${npmSection}\0${dependency.name}`)) continue;
        additions.push({
          ecosystem: 'npm',
          manifestPath: currentFile,
          name: dependency.name,
          production: npmSection === 'dependencies',
          internal: isInternalNpmDependency(dependency.name, dependency.version),
        });
      }
      continue;
    }

    if (basename(currentFile) === 'go.mod') {
      if (/^[ +]?require\s*\(\s*$/.test(line)) {
        inGoRequireBlock = true;
        continue;
      }
      if (inGoRequireBlock && /^[ +]?\)\s*$/.test(line)) {
        inGoRequireBlock = false;
        continue;
      }
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const match = goRequirePattern.exec(line);
      if (match?.[1]) {
        if (/\/\/\s*indirect\s*$/.test(line)) continue;
        const removedSameModulePattern = new RegExp(
          `^-\\s*(?:require\\s+)?${match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+v\\S+`
        );
        if (diff.split('\n').some((diffLine) => removedSameModulePattern.test(diffLine))) continue;
        additions.push({
          ecosystem: 'go',
          manifestPath: currentFile,
          name: match[1],
          production: true,
          internal: isInternalGoDependency(match[1]),
        });
      }
    }
  }

  return additions;
}

interface NpmManifestSnapshot {
  name?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label} in package manifest.`);
  }
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== 'string') throw new Error(`Invalid ${label} in package manifest.`);
    result[name] = version;
  }
  return result;
}

function parseNpmManifestSnapshot(raw: string | undefined): NpmManifestSnapshot {
  if (raw === undefined) return { dependencies: {}, devDependencies: {} };
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid package manifest.');
  }
  const name = 'name' in parsed ? parsed.name : undefined;
  const dependencies = 'dependencies' in parsed ? parsed.dependencies : undefined;
  const devDependencies = 'devDependencies' in parsed ? parsed.devDependencies : undefined;
  if (name !== undefined && typeof name !== 'string') {
    throw new Error('Invalid package name in package manifest.');
  }
  return {
    name,
    dependencies: stringRecord(dependencies, 'dependencies'),
    devDependencies: stringRecord(devDependencies, 'devDependencies'),
  };
}

function parseDirectGoRequirements(raw: string | undefined): Map<string, string> {
  const requirements = new Map<string, string>();
  if (raw === undefined) return requirements;
  let inRequireBlock = false;
  for (const sourceLine of raw.split('\n')) {
    const line = sourceLine.trim();
    if (line === 'require (') {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }
    const candidate = inRequireBlock ? line : line.startsWith('require ') ? line.slice(8) : '';
    if (!candidate || /\/\/\s*indirect\s*$/.test(candidate)) continue;
    const match = /^([^\s]+)\s+(v[^\s]+)(?:\s*\/\/.*)?$/.exec(candidate);
    if (match?.[1] && match[2]) requirements.set(match[1], match[2]);
  }
  return requirements;
}

function parseGoTools(raw: string | undefined): Set<string> {
  const tools = new Set<string>();
  if (raw === undefined) return tools;
  let inToolBlock = false;
  for (const sourceLine of raw.split('\n')) {
    const line = sourceLine.trim();
    if (line === 'tool (') {
      inToolBlock = true;
      continue;
    }
    if (inToolBlock && line === ')') {
      inToolBlock = false;
      continue;
    }
    const tool = inToolBlock ? line : line.startsWith('tool ') ? line.slice(5).trim() : '';
    if (tool && !tool.startsWith('//')) tools.add(tool);
  }
  return tools;
}

/** Compare complete manifest snapshots so diff context cannot hide additions. */
export function compareManifestSnapshots(
  manifestPath: string,
  beforeRaw: string | undefined,
  afterRaw: string | undefined
): DependencyAddition[] {
  if (basename(manifestPath) === 'package.json') {
    const before = parseNpmManifestSnapshot(beforeRaw);
    const after = parseNpmManifestSnapshot(afterRaw);
    const existingNames = new Set([
      ...Object.keys(before.dependencies),
      ...Object.keys(before.devDependencies),
    ]);
    const additions: DependencyAddition[] = [];
    for (const [section, production] of [
      [after.dependencies, true],
      [after.devDependencies, false],
    ] as const) {
      for (const [name, version] of Object.entries(section).sort(([left], [right]) =>
        left.localeCompare(right)
      )) {
        if (existingNames.has(name)) continue;
        additions.push({
          ecosystem: 'npm',
          manifestPath,
          name,
          production,
          internal: isInternalNpmDependency(name, version, after.name),
        });
      }
    }
    return additions;
  }

  if (basename(manifestPath) === 'go.mod') {
    const before = parseDirectGoRequirements(beforeRaw);
    const requirementAdditions = [...parseDirectGoRequirements(afterRaw)]
      .filter(([name]) => !before.has(name))
      .map(([name]) => ({
        ecosystem: 'go' as const,
        manifestPath,
        name,
        production: true,
        internal: isInternalGoDependency(name),
      }));
    const beforeTools = parseGoTools(beforeRaw);
    const toolAdditions = [...parseGoTools(afterRaw)]
      .filter((name) => !beforeTools.has(name))
      .map((name) => ({
        ecosystem: 'go' as const,
        manifestPath,
        name,
        production: true,
        internal: isInternalGoDependency(name),
      }));
    return [...requirementAdditions, ...toolAdditions].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  }

  return [];
}

function gitOutput(
  repositoryRoot: string,
  args: string[],
  allowMissing = false
): string | undefined {
  const result = spawnSync('/usr/bin/git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (allowMissing && result.status === 128) return undefined;
  if (result.error || result.status !== 0) {
    throw new Error('Could not compare direct dependency manifests against the base revision.');
  }
  return result.stdout;
}

function changedManifestPaths(repositoryRoot: string, base: string): string[] {
  const tracked =
    gitOutput(repositoryRoot, ['diff', '--name-only', '--diff-filter=ACMRT', '-z', base, '--'])
      ?.split('\0')
      .filter(Boolean) ?? [];
  const untracked =
    gitOutput(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
      ?.split('\0')
      .filter(Boolean) ?? [];
  return [...new Set([...tracked, ...untracked])]
    .map(normalizeRepoPath)
    .filter((path) => basename(path) === 'package.json' || basename(path) === 'go.mod')
    .sort((left, right) => left.localeCompare(right));
}

export function directDependencyAdditionsAgainstBase(
  repositoryRoot: string,
  base: string
): DependencyAddition[] {
  return changedManifestPaths(repositoryRoot, base).flatMap((manifestPath) => {
    const before = gitOutput(repositoryRoot, ['show', `${base}:${manifestPath}`], true);
    const currentPath = join(repositoryRoot, manifestPath);
    if (!existsSync(currentPath)) return [];
    if (!lstatSync(currentPath).isFile()) {
      throw new Error('Direct dependency manifests must be regular files.');
    }
    return compareManifestSnapshots(manifestPath, before, readFileSync(currentPath, 'utf8'));
  });
}

function validateEvidenceEntry(
  addition: DependencyAddition,
  evidence: DependencyEvidence | undefined
): string[] {
  const prefix = `${addition.ecosystem}:${addition.name}`;
  const errors: string[] = [];
  if (!evidence) return [`Missing direct dependency evidence for ${prefix}`];

  if (!evidence.registryUrl && !evidence.homepageUrl) {
    errors.push(`${prefix} needs registryUrl or homepageUrl`);
  }
  if (evidence.registryUrl && !urlPattern.test(evidence.registryUrl)) {
    errors.push(`${prefix} registryUrl must be an https URL`);
  }
  if (evidence.homepageUrl && !urlPattern.test(evidence.homepageUrl)) {
    errors.push(`${prefix} homepageUrl must be an https URL`);
  }
  if (!evidence.necessity || evidence.necessity.trim().split(/\s+/).length < 3) {
    errors.push(`${prefix} needs a one-line necessity with at least three words`);
  }
  if (evidence.necessity?.includes('\n')) {
    errors.push(`${prefix} necessity must be one line`);
  }
  return errors;
}

export function checkDirectDependencyEvidence(diff: string, evidence: EvidenceFile): CheckResult {
  const additions = extractDirectDependencyAdditions(diff);
  const relevantAdditions = additions.filter((addition) => !addition.internal);
  const errors = relevantAdditions.flatMap((addition) =>
    validateEvidenceEntry(addition, evidence[addition.ecosystem]?.[addition.name])
  );
  return { ok: errors.length === 0, additions, errors };
}

export function loadEvidence(path = evidencePath): EvidenceFile {
  if (!existsSync(path)) throw new Error('Direct dependency evidence file is missing.');
  const parsed = readJson(path);
  return v.parse(EvidenceFileSchema, parsed);
}

function baseRevision(): string {
  const base = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : 'origin/main';
  return base;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const additions = directDependencyAdditionsAgainstBase(repoRoot, baseRevision());
  const relevantAdditions = additions.filter((addition) => !addition.internal);
  const evidence = loadEvidence();
  const errors = relevantAdditions.flatMap((addition) =>
    validateEvidenceEntry(addition, evidence[addition.ecosystem]?.[addition.name])
  );
  const result = { ok: errors.length === 0, additions, errors };
  if (!result.ok) {
    console.error(
      [
        'Direct dependency evidence check failed:',
        ...result.errors.map((error) => `- ${error}`),
      ].join('\n')
    );
    process.exit(1);
  }
  console.log('Direct dependency evidence check passed.');
}
