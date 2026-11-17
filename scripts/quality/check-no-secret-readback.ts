/**
 * pnpm quality:no-secret-readback
 *
 * Blocks the code shapes that put a secret value GitHub does not know about into a GitHub
 * Actions runner, or that could print one (policy 795e72a6,
 * `.claude/rules/83-no-secret-readback-in-ci.md`):
 *
 *   show-secrets  reading secret values back out of Pulumi (`--show-secrets`, `showSecrets: true`)
 *   decryption    decrypting stored credentials (`subtle.decrypt`, `createDecipheriv`, importing
 *                 a decrypt helper or the API's encryption module, including multi-line imports)
 *   xtrace        shell tracing (`set -x`, `set -euxo`, `set -o xtrace`, `bash -x`)
 *   env-dump      dumping the environment (`env`, `printenv`, `export -p`, `declare -p`)
 *
 * It scans workflow, action, deploy, infra and CI-script code: every file under `.github/`,
 * `scripts/` and `infra/` with a shell, YAML or JS/TS extension, except tests and this checker.
 * Comment lines are skipped.
 *
 * A legacy line that cannot be removed yet is accepted only with a marker on the same line or
 * up to three lines above it, naming an open task file under tasks/backlog/ or tasks/active/:
 *
 *   # sam:secret-readback-allowed tasks/backlog/2026-11-17-remove-pulumi-secret-readback.md
 *
 * A marker naming an archived or missing task does not count: finishing the task must remove
 * the read.
 *
 * Usage: tsx scripts/quality/check-no-secret-readback.ts [--root <dir>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type RuleId = 'show-secrets' | 'decryption' | 'xtrace' | 'env-dump';

export interface Finding {
  file: string;
  line: number;
  rule: RuleId;
  text: string;
}

export interface AllowedRead extends Finding {
  task: string;
}

export interface ScanResult {
  findings: Finding[];
  allowed: AllowedRead[];
  /** Marker lines whose task is not an open task file: reported so a stale marker is visible. */
  invalidMarkers: Array<{ file: string; line: number; task: string }>;
}

interface Rule {
  id: RuleId;
  pattern: RegExp;
}

export const RULES: readonly Rule[] = [
  { id: 'show-secrets', pattern: /--show-secrets\b/ },
  { id: 'show-secrets', pattern: /\bshowSecrets\s*:\s*true\b/ },
  { id: 'decryption', pattern: /\bsubtle\s*\.\s*decrypt\s*\(/ },
  { id: 'decryption', pattern: /\bcreateDecipher(?:iv)?\s*\(/ },
  { id: 'decryption', pattern: /\brequire\s*\([^)]*\)\s*\.\s*decrypt\w*/i },
  { id: 'xtrace', pattern: /\bset\s+-[A-Za-z]*x[A-Za-z]*(?:\s|$|;)/ },
  { id: 'xtrace', pattern: /\bset\s+-o\s+xtrace\b/ },
  { id: 'xtrace', pattern: /(?:^|[\s;&|(])(?:ba|z)?sh\s+-[A-Za-z]*x[A-Za-z]*(?:\s|$)/ },
  { id: 'env-dump', pattern: /^\s*(?:env|printenv|export\s+-p|declare\s+-p)\s*(?:$|[|>;])/ },
  { id: 'env-dump', pattern: /^\s*printenv\b/ },
];

/**
 * Import or re-export statements, which can span lines: one that names a decrypt helper, or pulls
 * in the API's encryption module, is a `decryption` finding at the statement's first line.
 */
const IMPORT_STATEMENT = /^[ \t]*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;
const DECRYPT_NAME = /\bdecrypt\w*/i;
const ENCRYPTION_MODULE = /\/services\/encryption(?:\.[cm]?[jt]s)?$/;

export function decryptImportLines(text: string): number[] {
  const lines: number[] = [];
  for (const match of text.matchAll(IMPORT_STATEMENT)) {
    if (DECRYPT_NAME.test(match[0]) || ENCRYPTION_MODULE.test(match[1])) {
      lines.push(text.slice(0, match.index).split('\n').length);
    }
  }
  return lines;
}

const MARKER = /sam:secret-readback-allowed\s+(\S+)/;
const MARKER_REACH = 3;
const SCANNED_ROOTS = ['.github', 'scripts', 'infra'];
const SCANNED_EXTENSIONS = /\.(?:ya?ml|sh|bash|[cm]?[jt]s)$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '__tests__', 'fixtures']);
const SELF = 'scripts/quality/check-no-secret-readback.ts';

/** Test files, and this checker (its patterns are data, not reads). */
export function isScannedPath(path: string): boolean {
  if (!SCANNED_EXTENSIONS.test(path)) return false;
  if (path === SELF) return false;
  if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(path) || /(?:^|\/)test-[^/]*\.sh$/.test(path)) {
    return false;
  }
  return true;
}

function isCommentLine(line: string): boolean {
  return /^\s*(?:#|\/\/|\/\*|\*)/.test(line);
}

/** A task path is open when it names an existing file under tasks/backlog or tasks/active. */
export function openTaskExists(root: string, task: string): boolean {
  if (!/^tasks\/(?:backlog|active)\/[\w.-]+\.md$/.test(task)) return false;
  return existsSync(join(root, task));
}

export function scanText(
  file: string,
  text: string,
  isOpenTask: (task: string) => boolean
): ScanResult {
  const lines = text.split(/\r?\n/);
  const result: ScanResult = { findings: [], allowed: [], invalidMarkers: [] };
  const report = (index: number, rule: RuleId): void => {
    const finding: Finding = { file, line: index + 1, rule, text: lines[index].trim() };
    const task = markerTask(lines, index, isOpenTask);
    if (task) result.allowed.push({ ...finding, task });
    else result.findings.push(finding);
  };
  const importLines = new Set(decryptImportLines(text).map((line) => line - 1));
  lines.forEach((line, index) => {
    const marker = line.match(MARKER);
    if (marker && !isOpenTask(marker[1])) {
      result.invalidMarkers.push({ file, line: index + 1, task: marker[1] });
    }
    if (importLines.has(index)) {
      report(index, 'decryption');
      return;
    }
    if (isCommentLine(line)) return;
    const rule = RULES.find((candidate) => candidate.pattern.test(line));
    if (rule) report(index, rule.id);
  });
  return result;
}

function markerTask(
  lines: string[],
  index: number,
  isOpenTask: (task: string) => boolean
): string | null {
  for (let i = index; i >= Math.max(0, index - MARKER_REACH); i -= 1) {
    const marker = lines[i].match(MARKER);
    if (marker && isOpenTask(marker[1])) return marker[1];
  }
  return null;
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const path = relative(root, join(dir, entry.name)).split(sep).join('/');
        if (isScannedPath(path)) files.push(path);
      }
    }
  };
  for (const start of SCANNED_ROOTS) {
    const dir = join(root, start);
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  }
  return files.sort();
}

export function scanRepository(root: string): ScanResult & { files: number; lines: number } {
  const total: ScanResult & { files: number; lines: number } = {
    findings: [],
    allowed: [],
    invalidMarkers: [],
    files: 0,
    lines: 0,
  };
  const isOpenTask = (task: string) => openTaskExists(root, task);
  for (const file of listFiles(root)) {
    const text = readFileSync(join(root, file), 'utf8');
    const result = scanText(file, text, isOpenTask);
    total.files += 1;
    total.lines += text.split('\n').length;
    total.findings.push(...result.findings);
    total.allowed.push(...result.allowed);
    total.invalidMarkers.push(...result.invalidMarkers);
  }
  return total;
}

function main(): void {
  const rootFlag = process.argv.indexOf('--root');
  const root = resolve(rootFlag >= 0 ? process.argv[rootFlag + 1] : '.');
  const result = scanRepository(root);
  for (const read of result.allowed) {
    console.log(
      `allowed legacy read ${read.file}:${read.line} [${read.rule}] tracked by ${read.task}`
    );
  }
  const failed = result.findings.length > 0 || result.invalidMarkers.length > 0;
  if (failed) {
    console.error(
      'Secret readback, decryption, tracing or environment dumps in CI code (policy 795e72a6, .claude/rules/83-no-secret-readback-in-ci.md):'
    );
    for (const finding of result.findings) {
      console.error(`  ${finding.file}:${finding.line} [${finding.rule}] ${finding.text}`);
    }
    for (const marker of result.invalidMarkers) {
      console.error(
        `  ${marker.file}:${marker.line} marker names ${marker.task}, which is not an open task under tasks/backlog or tasks/active`
      );
    }
    console.error(
      'Remove the read. Ask Raphaël to configure the secret by hand or store it as a GitHub secret instead.'
    );
  }
  console.log(
    `Scanned ${result.files} files (${result.lines} lines): ${result.findings.length} finding(s), ${result.allowed.length} tracked legacy read(s), ${result.invalidMarkers.length} invalid marker(s).`
  );
  if (failed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
