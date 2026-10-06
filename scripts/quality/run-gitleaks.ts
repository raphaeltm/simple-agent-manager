import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function createCurrentTreeSnapshot(repositoryRoot: string, treeDirectory: string): void {
  const listed = spawnSync(
    '/usr/bin/git',
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
    const destinationPath = join(treeDirectory, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    if (stat.isFile()) {
      copyFileSync(sourcePath, destinationPath);
    } else if (stat.isSymbolicLink()) {
      // Scan the Git symlink blob (its target text) without following it.
      writeFileSync(destinationPath, readlinkSync(sourcePath), { mode: 0o600 });
    }
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
      process.env.SAM_GITLEAKS_BIN ?? '/usr/local/bin/gitleaks',
      [...gitleaksArgsForMode(mode, range), '--report-path', reportPath],
      { cwd: scanDirectory, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
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
    // The report is intentionally unredacted so reviewed hashes cannot be
    // forged by replacing a secret at the same rule/file/line. It remains only
    // in the private temporary directory and no scanner output is forwarded.
    // Both bounded modes honor the same exact, expiring reviewed digests. This
    // lets the PR-range scan distinguish a known non-secret marker touched by
    // formatting from genuinely new bytes without exposing finding metadata.
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

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) run();
