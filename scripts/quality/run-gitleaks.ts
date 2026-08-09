import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { evaluateGitleaksFindings, gitleaksArgsForMode } from './check-secret-scan-policy';

type ScanMode = 'current-tree' | 'pr-range';

const BASELINE_PATH = 'scripts/quality/gitleaks-reviewed-baseline.json';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function createCurrentTreeSnapshot(repositoryRoot: string, treeDirectory: string): void {
  const listed = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (listed.error || listed.status !== 0) {
    throw new Error('Could not enumerate the Git current tree for secret scanning.');
  }

  mkdirSync(treeDirectory, { recursive: true });
  for (const relativePath of listed.stdout.split('\0').filter(Boolean)) {
    const sourcePath = resolve(repositoryRoot, relativePath);
    const expectedPrefix = `${resolve(repositoryRoot)}${sep}`;
    if (!sourcePath.startsWith(expectedPrefix)) {
      throw new Error('Git returned a path outside the repository.');
    }
    if (!existsSync(sourcePath)) continue;
    const stat = lstatSync(sourcePath);
    if (!stat.isFile()) continue;
    const destinationPath = join(treeDirectory, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
  }
}

function run(): void {
  const mode = argument('mode') as ScanMode | undefined;
  if (mode !== 'current-tree' && mode !== 'pr-range') {
    throw new Error(
      'Use --mode=current-tree or --mode=pr-range. Full-history scans are private operations.'
    );
  }
  const repositoryRoot = process.cwd();
  const defaultRange = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}..HEAD`
    : 'origin/main..HEAD';
  const range = mode === 'pr-range' ? (argument('range') ?? defaultRange) : undefined;
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'sam-gitleaks-'));
  const reportPath = join(temporaryDirectory, 'report.json');
  const treeDirectory = join(temporaryDirectory, 'tree');

  try {
    const scanDirectory = mode === 'current-tree' ? treeDirectory : repositoryRoot;
    if (mode === 'current-tree') createCurrentTreeSnapshot(repositoryRoot, treeDirectory);
    const result = spawnSync(
      'gitleaks',
      [...gitleaksArgsForMode(mode, range), '--report-path', reportPath],
      { cwd: scanDirectory, encoding: 'utf8' }
    );
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      console.error('Gitleaks could not complete. Scanner output is withheld by policy.');
      process.exitCode = 1;
      return;
    }

    let report: string;
    try {
      report = readFileSync(reportPath, 'utf8');
    } catch {
      report = result.status === 0 ? '[]' : '';
    }
    const baseline = readFileSync(join(repositoryRoot, BASELINE_PATH), 'utf8');
    const evaluated = evaluateGitleaksFindings(report, baseline);
    if (!evaluated.ok) {
      console.error(
        evaluated.errors[0] ??
          'Gitleaks reported a finding. Finding details are withheld by policy.'
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `Gitleaks ${mode} scan passed (${evaluated.reviewedFindingCount} reviewed finding(s), 0 new).`
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

run();
