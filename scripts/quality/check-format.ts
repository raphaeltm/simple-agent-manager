import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { check, getFileInfo, resolveConfig } from 'prettier';

interface FormatBaseline {
  version: 1;
  formatter: string;
  baseCommit: string;
  extensions: string[];
  unformattedFileCount: number;
  reviewedAt: string;
  reviewBy: string;
}

export interface FormatCountComparison {
  ok: boolean;
  currentCount: number;
  baselineCount: number;
  increase: number;
}

const BASELINE_PATH = 'scripts/quality/format-baseline.json';

export function compareFormatCounts(
  currentCount: number,
  baselineCount: number
): FormatCountComparison {
  return {
    ok: currentCount <= baselineCount,
    currentCount,
    baselineCount,
    increase: Math.max(0, currentCount - baselineCount),
  };
}

function readBaseline(repositoryRoot: string): FormatBaseline {
  const parsed = JSON.parse(readFileSync(join(repositoryRoot, BASELINE_PATH), 'utf8')) as unknown;
  const baseline = parsed as Partial<FormatBaseline>;
  if (
    typeof baseline !== 'object' ||
    baseline === null ||
    baseline.version !== 1 ||
    typeof baseline.formatter !== 'string' ||
    typeof baseline.baseCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(baseline.baseCommit) ||
    !Array.isArray(baseline.extensions) ||
    baseline.extensions.some((extension) => typeof extension !== 'string') ||
    !Number.isInteger(baseline.unformattedFileCount) ||
    baseline.unformattedFileCount! < 0 ||
    typeof baseline.reviewedAt !== 'string' ||
    Number.isNaN(new Date(baseline.reviewedAt).valueOf()) ||
    typeof baseline.reviewBy !== 'string' ||
    Number.isNaN(new Date(baseline.reviewBy).valueOf())
  ) {
    throw new Error('The Prettier debt baseline is invalid.');
  }
  if (new Date(baseline.reviewBy) <= new Date()) {
    throw new Error('The Prettier debt baseline review has expired.');
  }
  return baseline as FormatBaseline;
}

function gitPaths(repositoryRoot: string, args: string[]): string[] {
  const result = spawnSync('/usr/bin/git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Could not enumerate files changed from the Prettier baseline.');
  }
  return result.stdout.split('\0').filter(Boolean);
}

function changedPaths(repositoryRoot: string, baseCommit: string): string[] {
  const tracked = gitPaths(repositoryRoot, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    baseCommit,
    '--',
  ]);
  const untracked = gitPaths(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...tracked, ...untracked])].sort((left, right) => left.localeCompare(right));
}

function fileAtRevision(
  repositoryRoot: string,
  revision: string,
  path: string
): string | undefined {
  const result = spawnSync('/usr/bin/git', ['show', `${revision}:${path}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 128) return undefined;
  if (result.error || result.status !== 0) {
    throw new Error('Could not read a file from the Prettier baseline commit.');
  }
  return result.stdout;
}

async function participates(path: string, extensions: Set<string>): Promise<boolean> {
  if (!extensions.has(extname(path))) return false;
  const information = await getFileInfo(path, { ignorePath: '.prettierignore' });
  return !information.ignored && information.inferredParser !== null;
}

async function isFormatted(content: string, path: string): Promise<boolean> {
  const config = await resolveConfig(path);
  return check(content, { ...config, filepath: path });
}

async function run(): Promise<void> {
  const repositoryRoot = process.cwd();
  const baseline = readBaseline(repositoryRoot);
  const extensions = new Set(baseline.extensions);
  let removedDebtCount = 0;
  let currentChangedDebtCount = 0;

  for (const path of changedPaths(repositoryRoot, baseline.baseCommit)) {
    if (!(await participates(path, extensions))) continue;
    const baselineContent = fileAtRevision(repositoryRoot, baseline.baseCommit, path);
    if (baselineContent !== undefined && !(await isFormatted(baselineContent, path))) {
      removedDebtCount += 1;
    }
    const currentPath = join(repositoryRoot, path);
    if (existsSync(currentPath)) {
      const currentContent = readFileSync(currentPath, 'utf8');
      if (!(await isFormatted(currentContent, path))) currentChangedDebtCount += 1;
    }
  }

  const currentCount = baseline.unformattedFileCount - removedDebtCount + currentChangedDebtCount;
  const comparison = compareFormatCounts(currentCount, baseline.unformattedFileCount);
  if (!comparison.ok) {
    console.error(
      `Prettier debt increased by ${comparison.increase} file(s): ${comparison.currentCount}/${comparison.baselineCount}.`
    );
    console.error(
      'Run pnpm format:check:strict to list the files, then format the changed source.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Prettier format ratchet passed: ${comparison.currentCount}/${comparison.baselineCount} unformatted file(s).`
  );
}

const isEntrypoint = process.argv[1]?.endsWith('check-format.ts');
if (isEntrypoint) await run();
