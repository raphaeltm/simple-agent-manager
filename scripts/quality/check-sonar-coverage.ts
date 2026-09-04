import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const GO_COVERAGE_REPORT_PATH = 'packages/cli/coverage.out';
const SONAR_PROPERTIES_PATH = 'sonar-project.properties';
const JAVASCRIPT_REPORT_PROPERTY = 'sonar.javascript.lcov.reportPaths';
const GO_REPORT_PROPERTY = 'sonar.go.coverage.reportPaths';

export interface PrepareJavaScriptCoverageOptions {
  normalize: boolean;
}

export interface JavaScriptCoverageSummary {
  lineRecords: number;
  reports: string[];
  sourceFiles: number;
}

interface WorkspaceFile {
  packages?: unknown;
}

function toRepositoryPath(path: string): string {
  return path.split(sep).join('/');
}

function assertRepositoryFile(root: string, candidate: string, description: string): string {
  const candidatePath = resolve(candidate);
  if (!existsSync(candidatePath) || !statSync(candidatePath).isFile()) {
    throw new Error(`${description} does not resolve to a repository source file.`);
  }
  const rootPath = realpathSync(resolve(root));
  const absolutePath = realpathSync(candidatePath);
  const relativePath = relative(rootPath, absolutePath);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${description} does not resolve to a repository source file.`);
  }
  return toRepositoryPath(relativePath);
}

function expandWorkspacePattern(root: string, pattern: string): string[] {
  if (isAbsolute(pattern) || pattern.split('/').includes('..')) {
    throw new Error(`Unsafe pnpm workspace pattern: ${pattern}`);
  }

  if (!pattern.includes('*')) return [pattern];
  if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
    throw new Error(`Unsupported pnpm workspace pattern: ${pattern}`);
  }

  const parent = pattern.slice(0, -2);
  const parentPath = join(root, parent);
  if (!existsSync(parentPath)) return [];
  return readdirSync(parentPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
}

function readWorkspacePatterns(root: string): string[] {
  const workspaceFile = parse(
    readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  ) as WorkspaceFile;
  if (
    !Array.isArray(workspaceFile.packages) ||
    !workspaceFile.packages.every((pattern): pattern is string => typeof pattern === 'string')
  ) {
    throw new Error('pnpm-workspace.yaml must define a string packages array.');
  }
  return workspaceFile.packages;
}

function isVitestCoverageCommand(command: unknown): command is string {
  return (
    typeof command === 'string' &&
    /(?:^|\s)vitest(?:\s|$)/u.test(command) &&
    /(?:^|\s)--coverage(?:[=\s]|$)/u.test(command)
  );
}

export function findJavaScriptCoverageReportPaths(root: string): string[] {
  const workspaces = readWorkspacePatterns(root).flatMap((pattern) =>
    expandWorkspacePattern(root, pattern)
  );
  const reportPaths = new Set<string>();

  for (const workspace of workspaces) {
    const manifestPath = join(root, workspace, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const coverageCommand =
      typeof manifest === 'object' &&
      manifest !== null &&
      'scripts' in manifest &&
      typeof manifest.scripts === 'object' &&
      manifest.scripts !== null &&
      'test:coverage' in manifest.scripts
        ? manifest.scripts['test:coverage']
        : undefined;
    if (isVitestCoverageCommand(coverageCommand)) {
      reportPaths.add(`${toRepositoryPath(workspace)}/coverage/lcov.info`);
    }
  }

  if (reportPaths.size === 0) {
    throw new Error('No Vitest coverage workspaces were discovered.');
  }
  return [...reportPaths].sort();
}

function readSonarProperties(root: string): Map<string, string> {
  const properties = new Map<string, string>();
  const contents = readFileSync(join(root, SONAR_PROPERTIES_PATH), 'utf8');

  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const separatorIndex = line.search(/[=:]/u);
    if (separatorIndex < 1) {
      throw new Error(`${SONAR_PROPERTIES_PATH}:${index + 1} is not a key/value property.`);
    }
    const key = line.slice(0, separatorIndex).trim();
    if (properties.has(key)) throw new Error(`Duplicate Sonar property: ${key}`);
    properties.set(key, line.slice(separatorIndex + 1).trim());
  }
  return properties;
}

export function assertSonarCoverageConfiguration(
  root: string,
  javascriptReportPaths: readonly string[]
): void {
  const properties = readSonarProperties(root);
  const expectedJavaScriptPaths = javascriptReportPaths.join(',');
  if (properties.get(JAVASCRIPT_REPORT_PROPERTY) !== expectedJavaScriptPaths) {
    throw new Error(`${JAVASCRIPT_REPORT_PROPERTY} must exactly equal ${expectedJavaScriptPaths}.`);
  }
  if (properties.get(GO_REPORT_PROPERTY) !== GO_COVERAGE_REPORT_PATH) {
    throw new Error(`${GO_REPORT_PROPERTY} must exactly equal ${GO_COVERAGE_REPORT_PATH}.`);
  }
}

function resolveLcovSource(root: string, reportPath: string, sourcePath: string): string {
  const reportWorkspace = dirname(dirname(reportPath));
  const candidates = isAbsolute(sourcePath)
    ? [sourcePath]
    : [join(root, sourcePath), join(root, reportWorkspace, sourcePath)];

  for (const candidate of candidates) {
    try {
      return assertRepositoryFile(root, candidate, `LCOV source ${sourcePath}`);
    } catch {
      // Try the workspace-relative form after the repository-relative form.
    }
  }
  throw new Error(`LCOV source ${sourcePath} does not resolve to a repository source file.`);
}

function normalizeLcovSourceRecord(
  root: string,
  reportPath: string,
  line: string,
  normalize: boolean
): string {
  const sourcePath = line.slice(3).trim();
  if (sourcePath === '') {
    throw new Error(`JavaScript coverage report ${reportPath} has an empty SF record.`);
  }
  const repositoryPath = resolveLcovSource(root, reportPath, sourcePath);
  if (!normalize && sourcePath !== repositoryPath) {
    throw new Error(
      `JavaScript coverage report ${reportPath} has a non-normalized SF path: ${sourcePath}.`
    );
  }
  return `SF:${repositoryPath}`;
}

function parseLcovContents(
  root: string,
  reportPath: string,
  originalContents: string,
  normalize: boolean
): { contents: string; lineRecords: number; sourceFiles: number } {
  const lines = originalContents.split(/\r?\n/u);
  let sourceFiles = 0;
  let lineRecords = 0;
  let recordOpen = false;

  for (const [index, line] of lines.entries()) {
    if (line.startsWith('SF:')) {
      if (recordOpen) {
        throw new Error(`JavaScript coverage report ${reportPath} has an unterminated record.`);
      }
      lines[index] = normalizeLcovSourceRecord(root, reportPath, line, normalize);
      sourceFiles += 1;
      recordOpen = true;
    } else if (line.startsWith('DA:')) {
      if (!recordOpen || !/^DA:\d+,\d+(?:,[^,\s]+)?$/u.test(line)) {
        throw new Error(
          `JavaScript coverage report ${reportPath} has a malformed DA record: ${line}.`
        );
      }
      lineRecords += 1;
    } else if (line === 'end_of_record') {
      if (!recordOpen) {
        throw new Error(`JavaScript coverage report ${reportPath} has an orphaned record end.`);
      }
      recordOpen = false;
    }
  }

  if (recordOpen) {
    throw new Error(`JavaScript coverage report ${reportPath} has an unterminated record.`);
  }
  if (sourceFiles === 0) {
    throw new Error(`JavaScript coverage report ${reportPath} has no SF source records.`);
  }
  if (lineRecords === 0) {
    throw new Error(`JavaScript coverage report ${reportPath} has no DA line records.`);
  }

  return { contents: lines.join('\n'), lineRecords, sourceFiles };
}

function validateAndNormalizeLcov(
  root: string,
  reportPath: string,
  normalize: boolean
): { contents: string; lineRecords: number; sourceFiles: number } {
  const absoluteReportPath = join(root, reportPath);
  if (!existsSync(absoluteReportPath)) {
    throw new Error(`Missing JavaScript coverage report: ${reportPath}`);
  }
  const originalContents = readFileSync(absoluteReportPath, 'utf8');
  if (originalContents.trim() === '') {
    throw new Error(`JavaScript coverage report ${reportPath} is empty.`);
  }
  return parseLcovContents(root, reportPath, originalContents, normalize);
}

export function prepareJavaScriptCoverageReports(
  root: string,
  options: PrepareJavaScriptCoverageOptions
): JavaScriptCoverageSummary {
  const reports = findJavaScriptCoverageReportPaths(root);
  assertSonarCoverageConfiguration(root, reports);
  let sourceFiles = 0;
  let lineRecords = 0;

  for (const report of reports) {
    const result = validateAndNormalizeLcov(root, report, options.normalize);
    sourceFiles += result.sourceFiles;
    lineRecords += result.lineRecords;
    if (options.normalize) writeFileSync(join(root, report), result.contents);
  }

  return { reports, sourceFiles, lineRecords };
}

function goModuleName(root: string): string {
  const goMod = readFileSync(join(root, 'packages/cli/go.mod'), 'utf8');
  const moduleMatch = goMod.match(/^module\s+(\S+)\s*$/mu);
  if (!moduleMatch) throw new Error('packages/cli/go.mod does not declare a module.');
  return moduleMatch[1];
}

function resolveGoSource(root: string, sourcePath: string, moduleName: string): void {
  const cliRoot = join(root, 'packages/cli');
  const candidates = sourcePath.startsWith(`${moduleName}/`)
    ? [join(cliRoot, sourcePath.slice(moduleName.length + 1))]
    : isAbsolute(sourcePath)
      ? [sourcePath]
      : [join(root, sourcePath), join(cliRoot, sourcePath)];
  for (const candidate of candidates) {
    try {
      assertRepositoryFile(root, candidate, `Go coverage source ${sourcePath}`);
      return;
    } catch {
      // Try all supported Go coverage source path forms.
    }
  }
  throw new Error(`Go coverage source ${sourcePath} does not resolve to a repository source file.`);
}

export function validateGoCoverageReport(root: string): void {
  const reportPath = join(root, GO_COVERAGE_REPORT_PATH);
  if (!existsSync(reportPath)) {
    throw new Error(`Missing Go coverage report: ${GO_COVERAGE_REPORT_PATH}`);
  }
  const contents = readFileSync(reportPath, 'utf8');
  if (contents.trim() === '') throw new Error('Go coverage report is empty.');
  const lines = contents.trimEnd().split(/\r?\n/u);
  if (!/^mode: (?:set|count|atomic)$/u.test(lines[0])) {
    throw new Error('Go coverage report has an invalid mode header.');
  }
  if (lines.length === 1) throw new Error('Go coverage report has no coverage records.');

  const moduleName = goModuleName(root);
  for (const line of lines.slice(1)) {
    const match = line.match(/^(.+):\d+\.\d+,\d+\.\d+ \d+ \d+$/u);
    if (!match) throw new Error(`Go coverage report has a malformed Go coverage record: ${line}.`);
    resolveGoSource(root, match[1], moduleName);
  }
}

type RequiredCoverage = 'all' | 'go' | 'javascript';

function runCli(): void {
  const args = process.argv.slice(2);
  const normalize = args.includes('--normalize');
  const requireArgument = args.find((argument) => argument.startsWith('--require='));
  const required = (requireArgument?.slice('--require='.length) ?? 'all') as RequiredCoverage;
  if (!['all', 'go', 'javascript'].includes(required)) {
    throw new Error('--require must be one of: all, go, javascript.');
  }
  const root = process.cwd();
  const javascriptReports = findJavaScriptCoverageReportPaths(root);
  assertSonarCoverageConfiguration(root, javascriptReports);

  if (required === 'all' || required === 'javascript') {
    const summary = prepareJavaScriptCoverageReports(root, { normalize });
    console.log(
      `Validated ${summary.reports.length} JavaScript coverage reports (${summary.sourceFiles} source files, ${summary.lineRecords} line records).`
    );
  }
  if (required === 'all' || required === 'go') {
    validateGoCoverageReport(root);
    console.log(`Validated Go coverage report ${GO_COVERAGE_REPORT_PATH}.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
