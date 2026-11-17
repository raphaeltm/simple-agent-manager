/**
 * pnpm quality:no-secret-readback
 *
 * Blocks the code shapes that put a secret value GitHub does not know about into a GitHub
 * Actions runner, or that could print one (policy 795e72a6,
 * `.claude/rules/83-no-secret-readback-in-ci.md`):
 *
 *   show-secrets  reading secret values back out of Pulumi (`--show-secrets`, `showSecrets`
 *                 unless `false`, `pulumi config get`)
 *   decryption    decrypting stored credentials (`subtle.decrypt`, `createDecipheriv`, importing
 *                 a decrypt helper or the API's encryption module: multi-line, re-export,
 *                 dynamic and destructured require/import included)
 *   xtrace        shell tracing (`set -x` in any flag cluster or position, `set -o xtrace`,
 *                 `bash -x`, a `-x` shebang, SHELLOPTS=xtrace, BASH_XTRACEFD, `trap ... DEBUG`)
 *   env-dump      dumping the environment (`env`, `printenv`, `export -p`, `declare -p`)
 *
 * It scans workflow, action, deploy, infra and CI-script code: every file under `.github/`,
 * `scripts/` and `infra/` with a shell, YAML or JS/TS extension, plus Dockerfiles, except tests
 * and this checker.
 * Comment lines are skipped.
 *
 * Shell-only rules (`bash -x`, SHELLOPTS, `trap DEBUG`, environment dumps) apply to `.sh` and
 * workflow YAML only, so JS/TS such as `value || env` is not reported.
 *
 * A legacy line that cannot be removed yet is accepted only with a marker on the same line or
 * directly above it, naming its tracking task, and only when that file and task are an
 * entry in ALLOWED_LEGACY_READS and the task is still open (under tasks/backlog/ or tasks/active/):
 * Only a `show-secrets` finding can be excused; a decryption, trace or dump next to a marker
 * is still reported.
 *
 *   # sam:secret-readback-allowed tasks/backlog/2026-11-17-remove-pulumi-secret-readback.md
 *
 * A marker naming an archived or missing task, or one not pinned to its file, does not count.
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
  /** Markers that excuse nothing (task not open, or file/task not in ALLOWED_LEGACY_READS). */
  invalidMarkers: Array<{ file: string; line: number; task: string }>;
}

interface Rule {
  id: RuleId;
  pattern: RegExp;
  /** Shell syntax: only matched in shell scripts and workflow YAML, never in JS/TS. */
  shellOnly?: boolean;
}

/** Shell options that follow `set`/`bash` on one command, up to a separator or comment. */
const SAME_COMMAND = String.raw`[^#\n;|&]*?`;
/**
 * The start of a shell command: line start, a YAML `run:` value, a Dockerfile `RUN`, or after
 * `;`, `&&`, `||`, `|`, or the opening of a subshell or command substitution (`(`, `$(`, a backtick),
 * so `echo "$(env)"` counts as running `env`. A `case` pattern at the start of a line (`*)`,
 * `a|b)`) is skipped, so `*) env ;;` is a command too.
 */
// Wrappers that still run the named command, with their own options: `command env`,
// `sudo -E env`, `sudo -u runner printenv`, `exec env`.
const WRAPPER = String.raw`(?:command|builtin|exec|sudo|nohup|time)(?:\s+(?:-[A-Za-z]+(?:\s+[^\s-]\S*)?|--[\w-]+(?:=\S+)?))*`;
const COMMAND_START = String.raw`(?:^\s*(?:-\s*)?(?:run:\s*|RUN\s+)?(?:[^\s()]+\)\s*)?|[;&|(\x60]\s*)(?:${WRAPPER}\s+)*`;
/** The end of a command with no further arguments: line end, a separator, a redirect, or the close
 * of a subshell or command substitution. */
const COMMAND_END = String.raw`\s*(?:$|[|>;&)\x60])`;

/** An optional directory before a command name: `/bin/bash`, `/usr/bin/env`. */
const EXECUTABLE_PATH = String.raw`(?:\S*/)?`;

export const RULES: readonly Rule[] = [
  { id: 'show-secrets', pattern: /--show-secrets\b/ },
  // Any use of the Automation API flag other than an explicit `false`, shorthand included.
  { id: 'show-secrets', pattern: /\bshowSecrets\b(?!\s*:\s*false\b)/ },
  // `pulumi config get` prints a secret config value decrypted.
  { id: 'show-secrets', pattern: /\bpulumi\s+config\s+get\b/ },
  // `subtle.decrypt(`, `subtle?.decrypt(`, `subtle['decrypt'](`, `subtle?.['decrypt'](`.
  {
    id: 'decryption',
    pattern: /\bsubtle\s*(?:\??\.\s*decrypt|(?:\?\.)?\[\s*['"`]decrypt['"`]\s*\])\s*\(/,
  },
  { id: 'decryption', pattern: /\bcreateDecipher(?:iv)?\s*\(/ },
  { id: 'decryption', pattern: /\brequire\s*\([^)]*\)\s*\.\s*decrypt\w*/i },
  // Dynamic import or require of the API's encryption module.
  {
    id: 'decryption',
    pattern: /\b(?:import|require)\s*\(\s*['"`][^'"`]*\/services\/encryption(?:\.[cm]?[jt]s)?['"`]/,
  },
  // `set -x`, `set -euxo pipefail`, `set -e -x`, `set -euo pipefail -x`.
  {
    id: 'xtrace',
    pattern: new RegExp(String.raw`\bset\b${SAME_COMMAND}\s-[A-Za-z]*x[A-Za-z]*(?=\s|$|;)`),
  },
  // `set -o xtrace`, `set -eo xtrace`, `set -o pipefail -o xtrace`.
  // ...and the same option on a shell invocation: `bash -o xtrace script.sh`.
  {
    id: 'xtrace',
    pattern: new RegExp(
      String.raw`\b(?:set|(?:ba|z|da|k)?sh)\b${SAME_COMMAND}\s-[A-Za-z]*o\s+xtrace\b`
    ),
  },
  // `bash -x`, `bash -e -x script.sh`, `shell: bash -x {0}`, `/bin/bash -x script.sh`.
  {
    id: 'xtrace',
    pattern: new RegExp(
      String.raw`(?:^|[\s;&|(])${EXECUTABLE_PATH}(?:ba|z|da|k)?sh\b${SAME_COMMAND}\s-[A-Za-z]*x[A-Za-z]*(?=\s|$)`
    ),
    shellOnly: true,
  },
  { id: 'xtrace', pattern: /\bSHELLOPTS=\S*xtrace|\bBASH_XTRACEFD\b/, shellOnly: true },
  { id: 'xtrace', pattern: /\btrap\b[^#\n]*\bDEBUG\b/, shellOnly: true },
  {
    id: 'env-dump',
    pattern: new RegExp(
      // Options or NAME=VALUE only, no command after them: `env -0`, `env -u NAME`, `env A=1`, a bare `export`,
      // `declare -x` or `set` all print the (exported) environment.
      String.raw`${COMMAND_START}${EXECUTABLE_PATH}(?:env(?:\s+(?:-u\s+\S+|--unset=\S+|-[-\w]+|[A-Za-z_]\w*=\S*))*|printenv|export(?:\s+-p)?|(?:declare|typeset)(?:\s+-[A-Za-z]+)*|set)${COMMAND_END}`
    ),
    shellOnly: true,
  },
  // `declare -p NAME`, `typeset -p A B`: print the named variables' values. Names only, so an
  // assignment (`declare -p X=1` is not valid; `declare X=1` has no -p) is not matched.
  {
    id: 'env-dump',
    pattern: new RegExp(
      String.raw`${COMMAND_START}(?:declare|typeset)\s+-[A-Za-z]*p[A-Za-z]*(?:\s+--)?(?:\s+[A-Za-z_]\w*)+${COMMAND_END}`
    ),
    shellOnly: true,
  },
  {
    id: 'env-dump',
    pattern: new RegExp(String.raw`${COMMAND_START}${EXECUTABLE_PATH}printenv\b`),
    shellOnly: true,
  },
];

const SHELL_FILE = /\.(?:ya?ml|sh|bash)$/;

/**
 * The legacy reads that may stay for now, each pinned to the file it lives in and the open task
 * that removes it. A marker counts only when its file and task match an entry here, so naming an
 * unrelated open task cannot excuse a new read.
 */
export const ALLOWED_LEGACY_READS: ReadonlyArray<{ file: string; task: string }> = [
  {
    file: 'scripts/deploy/configure-secrets.sh',
    task: 'tasks/backlog/2026-11-17-remove-pulumi-secret-readback.md',
  },
];

/**
 * Import or re-export statements, which can span lines: one that names a decrypt helper, or pulls
 * in the API's encryption module, is a `decryption` finding at the statement's first line.
 */
const IMPORT_STATEMENT = /^[ \t]*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;
const DECRYPT_NAME = /\bdecrypt\w*/i;
const ENCRYPTION_MODULE = /\/services\/encryption(?:\.[cm]?[jt]s)?$/;

/** `const { decryptX } = require(...)` or `= await import(...)`, which can span lines. */
const DESTRUCTURED_LOAD =
  /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:require|import)\s*\(/g;

export function decryptImportLines(text: string): number[] {
  const lines: number[] = [];
  const lineOf = (index: number) => text.slice(0, index).split('\n').length;
  for (const match of text.matchAll(IMPORT_STATEMENT)) {
    if (DECRYPT_NAME.test(match[0]) || ENCRYPTION_MODULE.test(match[1])) {
      lines.push(lineOf(match.index));
    }
  }
  for (const match of text.matchAll(DESTRUCTURED_LOAD)) {
    if (DECRYPT_NAME.test(match[1])) lines.push(lineOf(match.index));
  }
  return lines;
}

const MARKER = /sam:secret-readback-allowed\s+(\S+)/;
/** A marker excuses the read on its own line or the line directly below it, nothing further. */
const MARKER_REACH = 1;
/** Only a legacy Pulumi readback can be excused; decryption, tracing and dumps never can. */
const EXCUSABLE_RULES: ReadonlySet<RuleId> = new Set(['show-secrets']);
const SCANNED_ROOTS = ['.github', 'scripts', 'infra'];
const SCANNED_EXTENSIONS = /\.(?:ya?ml|sh|bash|[cm]?[jt]s)$/;
/** `Dockerfile`, `Dockerfile.ci`, `app.Dockerfile`: RUN lines are shell. */
const DOCKERFILE = /(?:^|\/)(?:[\w.-]+\.)?Dockerfile(?:\.[\w-]+)?$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '__tests__', 'fixtures']);
const SELF = 'scripts/quality/check-no-secret-readback.ts';

/** Test files, and this checker (its patterns are data, not reads). */
export function isScannedPath(path: string): boolean {
  if (!SCANNED_EXTENSIONS.test(path) && !DOCKERFILE.test(path)) return false;
  if (path === SELF) return false;
  // Shell `test-*.sh` scripts are scanned: workflows run some of them directly.
  if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(path)) {
    return false;
  }
  return true;
}

/** A shebang that turns on tracing (`#!/bin/bash -x`, `#!/usr/bin/env -S bash -ex`). */
const XTRACE_SHEBANG = /^#!.*\b(?:ba|z|da|k)?sh\s+-[A-Za-z]*x/;

/**
 * Comments that end on this line: a whole `/* ... *\/`, or the close of one opened earlier
 * (`*\/`, ` * text *\/`).
 */
const LEADING_CLOSED_COMMENTS = /^(?:\s*(?:\/\*.*?\*\/|\*\/|\*.*?\*\/))+/;

/**
 * A line that holds only a comment. A comment that ends on the line does not hide the code after
 * it: `/* compat *\/ crypto.subtle.decrypt(...)` and ` *\/ crypto.subtle.decrypt(...)` are scanned.
 */
function isCommentLine(line: string, shell: boolean): boolean {
  // Shell, YAML and Dockerfiles: only `#`. A leading `*` there is a glob or a `case` pattern (`*) env ;;`).
  if (shell) return /^\s*#/.test(line);
  const code = line.replace(LEADING_CLOSED_COMMENTS, '');
  if (code !== line && code.trim() === '') return true;
  return /^\s*(?:#|\/\/|\/\*|\*)/.test(code);
}

/** A task path is open when it names an existing file under tasks/backlog or tasks/active. */
export function openTaskExists(root: string, task: string): boolean {
  if (!/^tasks\/(?:backlog|active)\/[\w.-]+\.md$/.test(task)) return false;
  return existsSync(join(root, task));
}

/**
 * Scan one file. `isAllowed(task)` says whether a marker naming `task` may excuse a read in this
 * file (scanRepository: an ALLOWED_LEGACY_READS entry for the file, and the task still open).
 */
export function scanText(
  file: string,
  text: string,
  isAllowed: (task: string) => boolean
): ScanResult {
  const lines = text.split(/\r?\n/);
  const result: ScanResult = { findings: [], allowed: [], invalidMarkers: [] };
  const report = (index: number, rule: RuleId): void => {
    const finding: Finding = { file, line: index + 1, rule, text: lines[index].trim() };
    const task = EXCUSABLE_RULES.has(rule) ? markerTask(lines, index, isAllowed) : null;
    if (task) result.allowed.push({ ...finding, task });
    else result.findings.push(finding);
  };
  const shell = SHELL_FILE.test(file) || DOCKERFILE.test(file);
  // Every file type: workflow YAML and shell heredocs carry inline JS.
  const importLines = new Set(decryptImportLines(text).map((line) => line - 1));
  let continuedUntil = -1;
  lines.forEach((line, index) => {
    const marker = MARKER.exec(line);
    if (marker && !isAllowed(marker[1])) {
      result.invalidMarkers.push({ file, line: index + 1, task: marker[1] });
    }
    if (importLines.has(index)) {
      report(index, 'decryption');
      return;
    }
    if (index === 0 && XTRACE_SHEBANG.test(line)) {
      report(index, 'xtrace');
      return;
    }
    if (index <= continuedUntil || isCommentLine(line, shell)) return;
    const logical = logicalLine(lines, index, shell);
    continuedUntil = logical.lastIndex;
    // Every rule that matches, so a marker that excuses a readback cannot hide a trace on the
    // same line.
    const matched = new Set(
      RULES.filter(
        (candidate) => (!candidate.shellOnly || shell) && candidate.pattern.test(logical.text)
      ).map((candidate) => candidate.id)
    );
    for (const rule of matched) report(index, rule);
  });
  return result;
}

/**
 * A JS method chain split across lines: the next line starts with `.name`/`?.` (or `[` outside
 * shell, where `[ ... ]` is a test), or this line ends with `name.`. Shell and YAML files carry
 * inline JS in heredocs, so the `.name` forms apply to them too.
 */
function continuesChain(text: string, next: string, shell: boolean): boolean {
  if (/^\s*\??\.[A-Za-z_$]/.test(next) || /[\w$)\]]\.\s*$/.test(text)) return true;
  // In shell, `[ ... ]` is a test; only a bracket immediately followed by a quoted key
  // (`['decrypt']`) is JS member access.
  return shell ? /^\s*(?:\?\.)?\[['"`]/.test(next) : /^\s*\[/.test(next);
}

/** Physical lines a logical line may span, so a pathological file cannot make the scan quadratic. */
const MAX_CONTINUATION_LINES = 20;

/**
 * One statement split across lines, reported at its first line: shell `\` continuations (every
 * file type, since YAML and Dockerfiles carry shell), and in JS/TS a method chain whose next line
 * starts with `.`/`?.`/`[` or whose line ends with `.` (`crypto.subtle` / `.decrypt(...)`).
 */
function logicalLine(
  lines: string[],
  start: number,
  shell: boolean
): { text: string; lastIndex: number } {
  let text = lines[start];
  let index = start;
  while (index + 1 < lines.length && index - start < MAX_CONTINUATION_LINES) {
    const next = lines[index + 1];
    if (/\\\s*$/.test(text)) {
      text = `${text.replace(/\\\s*$/, '')} ${next.trim()}`;
    } else if (continuesChain(text, next, shell)) {
      text = `${text.trimEnd()}${next.trim()}`;
    } else {
      break;
    }
    index += 1;
  }
  return { text, lastIndex: index };
}

function markerTask(
  lines: string[],
  index: number,
  isAllowed: (task: string) => boolean
): string | null {
  for (let i = index; i >= Math.max(0, index - MARKER_REACH); i -= 1) {
    const marker = MARKER.exec(lines[i]);
    if (marker && isAllowed(marker[1])) return marker[1];
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
  return files.sort((a, b) => a.localeCompare(b));
}

export function scanRepository(root: string): ScanResult & { files: number; lines: number } {
  const total: ScanResult & { files: number; lines: number } = {
    findings: [],
    allowed: [],
    invalidMarkers: [],
    files: 0,
    lines: 0,
  };
  for (const file of listFiles(root)) {
    const text = readFileSync(join(root, file), 'utf8');
    const isAllowed = (task: string) =>
      ALLOWED_LEGACY_READS.some((read) => read.file === file && read.task === task) &&
      openTaskExists(root, task);
    const result = scanText(file, text, isAllowed);
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
