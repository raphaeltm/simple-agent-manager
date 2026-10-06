import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';

export interface SamShadowFinding {
  file: string;
  line: number;
  message: string;
  rule: string;
}

interface OxlintLabel {
  span?: { line?: number };
}

interface OxlintDiagnostic {
  code?: string;
  filename?: string;
  labels?: OxlintLabel[];
  message?: string;
}

function parseOxlintDiagnostics(raw: string): OxlintDiagnostic[] {
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('diagnostics' in parsed) ||
    !Array.isArray(parsed.diagnostics)
  ) {
    throw new Error('Oxlint SAM shadow returned an unexpected JSON report.');
  }
  return parsed.diagnostics as OxlintDiagnostic[];
}

export function normalizeOxlintSamFindings(diagnostics: OxlintDiagnostic[]): SamShadowFinding[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.code?.startsWith('sam('))
    .map((diagnostic) => ({
      file: diagnostic.filename ?? '<unknown>',
      line: diagnostic.labels?.[0]?.span?.line ?? 0,
      message: diagnostic.message ?? '',
      rule: diagnostic.code?.replace(/^sam\((.+)\)$/, 'sam/$1') ?? '',
    }))
    .sort(compareFinding);
}

function compareFinding(left: SamShadowFinding, right: SamShadowFinding): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.rule.localeCompare(right.rule) ||
    left.message.localeCompare(right.message)
  );
}

export function findingsConform(
  eslintFindings: SamShadowFinding[],
  oxlintFindings: SamShadowFinding[]
): boolean {
  return (
    JSON.stringify([...eslintFindings].sort(compareFinding)) === JSON.stringify(oxlintFindings)
  );
}

async function run(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const fixtureGlob = 'packages/eslint-plugin-sam/tests/fixtures/*.ts';
  const fixtureDirectory = 'packages/eslint-plugin-sam/tests/fixtures';
  const eslint = new ESLint({ cwd: repoRoot });
  const eslintResults = await eslint.lintFiles([fixtureGlob]);
  const eslintFindings = eslintResults
    .flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId?.startsWith('sam/'))
        .map((message) => ({
          file: relative(repoRoot, result.filePath).replaceAll('\\', '/'),
          line: message.line,
          message: message.message,
          rule: message.ruleId ?? '',
        }))
    )
    .sort(compareFinding);

  const oxlint = spawnSync(
    resolve(repoRoot, 'node_modules/.bin/oxlint'),
    ['--config', '.oxlintrc.sam-shadow.json', '--format', 'json', fixtureDirectory],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  if (oxlint.error || oxlint.status !== 0) {
    throw new Error('Oxlint alpha JS-plugin shadow could not complete.');
  }
  const oxlintFindings = normalizeOxlintSamFindings(parseOxlintDiagnostics(oxlint.stdout));
  const conformant = findingsConform(eslintFindings, oxlintFindings);
  console.log(
    `Oxlint SAM alpha shadow: ${oxlintFindings.length}/${eslintFindings.length} fixture findings; ` +
      `finding conformance=${conformant ? '100%' : 'incomplete'}; non-authoritative.`
  );
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) await run();
