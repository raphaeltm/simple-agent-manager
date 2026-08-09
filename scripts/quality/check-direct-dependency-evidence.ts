import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function nearestWorkspacePackageName(manifestPath: string): string | undefined {
  try {
    const manifest = readJson(join(repoRoot, manifestPath));
    if (
      typeof manifest === 'object' &&
      manifest !== null &&
      'name' in manifest &&
      typeof manifest.name === 'string'
    ) {
      return manifest.name;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isInternalNpmDependency(name: string, version: string, manifestPath: string): boolean {
  if (version.startsWith('workspace:')) return true;
  if (name.startsWith('@simple-agent-manager/')) return true;
  return nearestWorkspacePackageName(manifestPath) === name;
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
          internal: isInternalNpmDependency(dependency.name, dependency.version, currentFile),
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
  const relevantAdditions = additions.filter(
    (addition) => addition.production && !addition.internal
  );
  const errors = relevantAdditions.flatMap((addition) =>
    validateEvidenceEntry(addition, evidence[addition.ecosystem]?.[addition.name])
  );
  return { ok: errors.length === 0, additions, errors };
}

export function loadEvidence(path = evidencePath): EvidenceFile {
  if (!existsSync(path)) return {};
  const parsed = readJson(path);
  if (typeof parsed !== 'object' || parsed === null) return {};
  return parsed as EvidenceFile;
}

function diffAgainstBase(): string {
  const base = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : 'origin/main';
  return execFileSync(
    'git',
    ['diff', '--unified=0', `${base}...HEAD`, '--', '**/package.json', '**/go.mod'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkDirectDependencyEvidence(diffAgainstBase(), loadEvidence());
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
