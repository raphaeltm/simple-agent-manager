/**
 * Report-only repo quality visibility guard.
 *
 * Surfaces oversized source/test files and coverage threshold drift against a
 * checked-in baseline. The default mode exits 0 so it can run locally or in CI
 * without destabilizing the current build; pass --strict to make drift fail.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

type CoverageMetric = 'statements' | 'branches' | 'functions' | 'lines';
type CoverageThresholds = Record<CoverageMetric, number>;

type Baseline = {
  fileSizeBudgets: {
    sourceWarnLines: number;
    sourceOversizedLines: number;
    testWarnLines: number;
    testOversizedLines: number;
  };
  coverageThresholds: Record<string, CoverageThresholds>;
};

type FileSizeFinding = {
  file: string;
  lines: number;
  kind: 'source' | 'test';
  severity: 'warning' | 'oversized';
};

type CoverageDrift = {
  file: string;
  metric: CoverageMetric;
  baseline: number | null;
  current: number | null;
  direction: 'added' | 'removed' | 'lowered' | 'raised';
};

const ROOT = resolve(import.meta.dirname, '../..');
const BASELINE_PATH = resolve(ROOT, 'scripts/quality/repo-quality-baseline.json');
const COVERAGE_METRICS: CoverageMetric[] = ['statements', 'branches', 'functions', 'lines'];
const SOURCE_EXTENSIONS = /\.(ts|tsx|go)$/;
const TEST_PATTERNS = [/\.test\./, /\.spec\./, /_test\.go$/];
const EXCLUDED_PATH_PATTERNS = [/\/node_modules\//, /\/dist\//, /\.d\.ts$/, /\.generated\./];
const PATH_COLLATOR = new Intl.Collator('en');
const COVERAGE_THRESHOLD_PATTERN =
  /coverageConfig\([^]*?\{\s*statements:\s*(\d+),\s*branches:\s*(\d+),\s*functions:\s*(\d+),\s*lines:\s*(\d+),\s*\}/m;

export function isTestFile(file: string): boolean {
  return TEST_PATTERNS.some((pattern) => pattern.test(file));
}

export function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length;
}

export function parseCoverageThresholds(source: string): CoverageThresholds | null {
  const match = COVERAGE_THRESHOLD_PATTERN.exec(source);
  if (!match) return null;
  return {
    statements: Number(match[1]),
    branches: Number(match[2]),
    functions: Number(match[3]),
    lines: Number(match[4]),
  };
}

export function compareCoverageThresholds(
  baseline: Record<string, CoverageThresholds>,
  current: Record<string, CoverageThresholds>
): CoverageDrift[] {
  const files = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const drift: CoverageDrift[] = [];

  for (const file of [...files].sort((left, right) => PATH_COLLATOR.compare(left, right))) {
    for (const metric of COVERAGE_METRICS) {
      const baselineValue = baseline[file]?.[metric] ?? null;
      const currentValue = current[file]?.[metric] ?? null;
      if (baselineValue === currentValue) continue;

      let direction: CoverageDrift['direction'];
      if (baselineValue === null) direction = 'added';
      else if (currentValue === null) direction = 'removed';
      else direction = currentValue < baselineValue ? 'lowered' : 'raised';

      drift.push({ file, metric, baseline: baselineValue, current: currentValue, direction });
    }
  }

  return drift;
}

export function classifyFileSize(
  file: string,
  lines: number,
  budgets: Baseline['fileSizeBudgets']
): FileSizeFinding | null {
  const kind = isTestFile(file) ? 'test' : 'source';
  const warnLines = kind === 'test' ? budgets.testWarnLines : budgets.sourceWarnLines;
  const oversizedLines =
    kind === 'test' ? budgets.testOversizedLines : budgets.sourceOversizedLines;

  if (lines > oversizedLines) return { file, lines, kind, severity: 'oversized' };
  if (lines > warnLines) return { file, lines, kind, severity: 'warning' };
  return null;
}

function loadBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Baseline;
}

function listCandidateFiles(): string[] {
  return ['apps', 'packages']
    .flatMap((directory) => collectSourceFiles(resolve(ROOT, directory)))
    .filter((file) => file && SOURCE_EXTENSIONS.test(file))
    .filter((file) => !EXCLUDED_PATH_PATTERNS.some((pattern) => pattern.test(`/${file}`)));
}

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(entryPath);
    if (!entry.isFile()) return [];
    return relative(ROOT, entryPath);
  });
}

function scanFileSizes(baseline: Baseline): FileSizeFinding[] {
  return listCandidateFiles()
    .map((file) => {
      const content = readFileSync(resolve(ROOT, file), 'utf-8');
      return classifyFileSize(file, countLines(content), baseline.fileSizeBudgets);
    })
    .filter((finding): finding is FileSizeFinding => finding !== null)
    .sort((left, right) => {
      const lineDifference = right.lines - left.lines;
      return lineDifference || PATH_COLLATOR.compare(left.file, right.file);
    });
}

function readCurrentCoverageThresholds(baseline: Baseline): Record<string, CoverageThresholds> {
  const current: Record<string, CoverageThresholds> = {};
  for (const file of Object.keys(baseline.coverageThresholds).sort((left, right) =>
    PATH_COLLATOR.compare(left, right)
  )) {
    const thresholds = parseCoverageThresholds(readFileSync(resolve(ROOT, file), 'utf-8'));
    if (thresholds) current[file] = thresholds;
  }
  return current;
}

function formatReport(fileFindings: FileSizeFinding[], coverageDrift: CoverageDrift[]): string {
  const lines = ['Repo quality visibility report', ''];

  lines.push(`Oversized file visibility: ${fileFindings.length} finding(s)`);
  for (const finding of fileFindings.slice(0, 30)) {
    lines.push(
      `  ${finding.severity.toUpperCase()} ${finding.kind.padEnd(6)} ${finding.lines} lines  ${finding.file}`
    );
  }
  if (fileFindings.length > 30) {
    lines.push(`  ... ${fileFindings.length - 30} more finding(s) omitted from console output`);
  }

  lines.push('', `Coverage threshold drift: ${coverageDrift.length} finding(s)`);
  for (const drift of coverageDrift) {
    lines.push(
      `  ${drift.direction.toUpperCase()} ${drift.file} ${drift.metric}: baseline=${drift.baseline ?? 'n/a'} current=${drift.current ?? 'n/a'}`
    );
  }

  lines.push('', 'Default mode is report-only. Use --strict to fail on coverage threshold drift.');
  return lines.join('\n');
}

function main(): void {
  const strict = process.argv.includes('--strict');
  const json = process.argv.includes('--json');
  const baseline = loadBaseline();
  const fileFindings = scanFileSizes(baseline);
  const coverageDrift = compareCoverageThresholds(
    baseline.coverageThresholds,
    readCurrentCoverageThresholds(baseline)
  );

  if (json) {
    console.log(JSON.stringify({ fileFindings, coverageDrift }, null, 2));
  } else {
    console.log(formatReport(fileFindings, coverageDrift));
  }

  process.exit(strict && coverageDrift.length > 0 ? 1 : 0);
}

if (relative(ROOT, process.argv[1] ?? '') === 'scripts/quality/check-repo-quality-visibility.ts') {
  main();
}
