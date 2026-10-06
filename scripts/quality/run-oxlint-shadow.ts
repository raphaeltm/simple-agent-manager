import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface OxlintDiagnostic {
  code: string;
  severity: string;
}

export interface OxlintReport {
  diagnostics: OxlintDiagnostic[];
  number_of_files: number;
  number_of_rules: number;
  start_time: number;
  threads_count: number;
}

export interface OxlintSummary {
  diagnostics: number;
  files: number;
  mode: 'report-only';
  rules: number;
  seconds: number;
  topRules: Array<{ count: number; rule: string }>;
}

function parseOxlintReport(raw: string): OxlintReport {
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('diagnostics' in parsed) ||
    !Array.isArray(parsed.diagnostics) ||
    !('number_of_files' in parsed) ||
    typeof parsed.number_of_files !== 'number' ||
    !('number_of_rules' in parsed) ||
    typeof parsed.number_of_rules !== 'number' ||
    !('start_time' in parsed) ||
    typeof parsed.start_time !== 'number' ||
    !('threads_count' in parsed) ||
    typeof parsed.threads_count !== 'number' ||
    !parsed.diagnostics.every(
      (diagnostic) =>
        typeof diagnostic === 'object' &&
        diagnostic !== null &&
        'code' in diagnostic &&
        typeof diagnostic.code === 'string' &&
        'severity' in diagnostic &&
        typeof diagnostic.severity === 'string'
    )
  ) {
    throw new Error('Oxlint returned an unexpected JSON report shape.');
  }
  return parsed as OxlintReport;
}

export function summarizeOxlintReport(report: OxlintReport): OxlintSummary {
  const counts = new Map<string, number>();
  for (const diagnostic of report.diagnostics) {
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }

  return {
    diagnostics: report.diagnostics.length,
    files: report.number_of_files,
    mode: 'report-only',
    rules: report.number_of_rules,
    seconds: report.start_time,
    topRules: [...counts.entries()]
      .sort(
        ([leftRule, leftCount], [rightRule, rightCount]) =>
          rightCount - leftCount || leftRule.localeCompare(rightRule)
      )
      .slice(0, 10)
      .map(([rule, count]) => ({ count, rule })),
  };
}

function runOxlintShadow(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const binary = path.join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint'
  );
  const result = spawnSync(
    binary,
    [
      '--config',
      '.oxlintrc.json',
      '--format',
      'json',
      'apps',
      'packages',
      'infra',
      'tools',
      'scripts',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const diagnostic = result.stderr.trim() || 'Oxlint exited without diagnostics.';
    throw new Error(`Oxlint shadow execution failed: ${diagnostic}`);
  }

  const report = parseOxlintReport(result.stdout);
  const summary = summarizeOxlintReport(report);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary));
    return;
  }

  console.log(
    `Oxlint shadow: ${summary.diagnostics} advisory diagnostics across ${summary.files} files ` +
      `(${summary.rules} rules, ${summary.seconds.toFixed(3)}s). ESLint remains authoritative.`
  );
  for (const entry of summary.topRules) {
    console.log(`  ${entry.rule}: ${entry.count}`);
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runOxlintShadow();
}
