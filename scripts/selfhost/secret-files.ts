/**
 * Root-only files that hold Worker secrets for a celld box.
 *
 * celld has no secrets mechanism for real nodes, so secrets reach the Worker as `vars` in
 * the config passed to `celld deploy`. They live on the box in files only the operator can
 * read, and the rendered config that carries them is deleted after each deploy.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import * as v from 'valibot';

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Throws unless `path` is a regular file owned by this user with no group/other access. */
export function assertPrivateFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(
        `${path} is readable by group or others (mode ${(stat.mode & 0o777).toString(8)}); run: chmod 600 ${path}`
      );
    }
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(`${path} is owned by uid ${stat.uid}, not the deploying user (${uid})`);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes `content` to a new or existing file with mode 0600, replacing its contents. The mode
 * is enforced and checked on the open descriptor before any byte is written, so an existing
 * world-readable file is tightened (or refused, if owned by someone else) first.
 */
export function writePrivateFile(path: string, content: string): void {
  const fd = openSync(path, 'w', 0o600);
  try {
    fchmodSync(fd, 0o600);
    const uid = process.getuid?.();
    const stat = fstatSync(fd);
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(`${path} is owned by uid ${stat.uid}, not the deploying user (${uid})`);
    }
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/** Writes `content` to a new file (mode 0600, refusing an existing one) and fsyncs it. */
function writeNewPrivateFileSynced(path: string, content: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces `path` with `content` so a crash leaves either the old or the new file, never a torn
 * one, and a concurrent reader (docker compose reading an env_file) sees one of them whole: a
 * 0600 temp file in the same directory is written and fsynced, then renamed over `path`. An
 * existing `path` owned by another user is refused first. With `backup`, an existing file's
 * content is first kept as `<path>.bak` (0600, same way).
 */
export function replacePrivateFile(
  path: string,
  content: string,
  options: { backup?: boolean } = {}
): void {
  const current = lstatSync(path, { throwIfNoEntry: false });
  const uid = process.getuid?.();
  if (current && uid !== undefined && current.uid !== uid) {
    throw new Error(`${path} is owned by uid ${current.uid}, not the deploying user (${uid})`);
  }
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  const stage = (target: string, text: string): void => {
    rmSync(temp, { force: true });
    try {
      writeNewPrivateFileSynced(temp, text);
      renameSync(temp, target);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  };
  if (options.backup && existsSync(path)) {
    assertPrivateFile(path);
    stage(`${path}.bak`, readFileSync(path, 'utf8'));
  }
  stage(path, content);
  fsyncDir(dir);
}

/** Creates `dir` (mode 0700) or tightens an existing one, and checks it belongs to this user. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const uid = process.getuid?.();
  const stat = statSync(dir);
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${dir} is owned by uid ${stat.uid}, not the deploying user (${uid})`);
  }
}

function unescapeDoubleQuoted(raw: string): string {
  return raw.replace(/\\(.)/g, (_m, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 'r') return '\r';
    if (ch === 't') return '\t';
    return ch;
  });
}

/** Index of the first `"` not preceded by a backslash escape, or -1. */
function closingQuoteIndex(body: string): number {
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\') i += 1;
    else if (body[i] === '"') return i;
  }
  return -1;
}

const DOTENV_NAME = /^[A-Za-z_]\w*$/;
/** Characters `.` does not match: the old single-regex parser refused a line containing one. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const LEADING_SPACE = /^\s/;

/**
 * Splits `[export ]NAME = rest` into the name and the value text, or returns null. Plain string
 * parsing: a single regex with `\s*=\s*(.*)` backtracks super-linearly on adversarial input.
 */
function splitAssignment(line: string): { name: string; rest: string } | null {
  const eq = line.indexOf('=');
  if (eq === -1) return null;
  const rest = line.slice(eq + 1).trimStart();
  if (LINE_BREAK.test(rest)) return null;
  const lhs = line.slice(0, eq).trimEnd();
  if (DOTENV_NAME.test(lhs)) return { name: lhs, rest };
  const afterExport = lhs.slice('export'.length);
  if (lhs.startsWith('export') && LEADING_SPACE.test(afterExport)) {
    const name = afterExport.trimStart();
    if (DOTENV_NAME.test(name)) return { name, rest };
  }
  return null;
}

/**
 * Reads a double-quoted value that opens on `lines[start]` and may span lines (a PEM pasted
 * as-is). Returns the value and the index of the line holding the closing quote.
 */
function readDoubleQuoted(
  lines: readonly string[],
  start: number,
  rest: string,
  source: string
): { value: string; lastLine: number } {
  const lineNo = start + 1;
  let last = start;
  let body = rest.slice(1);
  let end = closingQuoteIndex(body);
  while (end === -1) {
    last += 1;
    if (last >= lines.length) throw new Error(`${source}:${lineNo}: unterminated double quote`);
    body += `\n${lines[last]}`;
    end = closingQuoteIndex(body);
  }
  const trailing = body.slice(end + 1).trim();
  if (trailing !== '' && !trailing.startsWith('#')) {
    throw new Error(`${source}:${lineNo}: unexpected text after closing quote`);
  }
  return { value: unescapeDoubleQuoted(body.slice(0, end)), lastLine: last };
}

/** Reads a `'literal'` or unquoted value; an unquoted value ends at a ` #` comment. */
function readSingleLineValue(rest: string, lineNo: number, source: string): string {
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    if (end === -1) throw new Error(`${source}:${lineNo}: unterminated single quote`);
    return rest.slice(1, end);
  }
  const hash = rest.search(/\s#/);
  return (hash === -1 ? rest : rest.slice(0, hash)).trim();
}

/**
 * Parses a dotenv file: `NAME=value`, `export NAME=value`, `#` comments, `'literal'`, and
 * `"double"` values with `\n` escapes that may also span lines (multi-line PEM keys).
 * No interpolation. Throws on any line it cannot parse, naming the line but never its value.
 */
export function parseDotenv(text: string, source: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = (lines[i] ?? '').trim();
    if (line !== '' && !line.startsWith('#')) {
      const assignment = splitAssignment(line);
      if (!assignment) throw new Error(`${source}:${i + 1}: expected NAME=value`);
      if (assignment.rest.startsWith('"')) {
        const quoted = readDoubleQuoted(lines, i, assignment.rest, source);
        values[assignment.name] = quoted.value;
        i = quoted.lastLine;
      } else {
        values[assignment.name] = readSingleLineValue(assignment.rest, i + 1, source);
      }
    }
    i += 1;
  }
  return values;
}

/** Reads a root-only dotenv file of Worker secrets. A missing file yields `{}`. */
export function readSecretsFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  assertPrivateFile(path);
  const parsed = parseDotenv(readFileSync(path, 'utf8'), path);
  for (const name of Object.keys(parsed)) {
    if (!SECRET_NAME.test(name))
      throw new Error(`${path}: ${name} is not an UPPER_SNAKE_CASE name`);
  }
  return parsed;
}

const StringMapSchema = v.record(v.pipe(v.string(), v.regex(SECRET_NAME)), v.string());

/** Reads a root-only JSON object of string values (the generated platform keys). */
export function readPrivateJson(path: string): Record<string, string> {
  assertPrivateFile(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const result = v.safeParse(StringMapSchema, raw);
  if (!result.success)
    throw new Error(`${path} must be a JSON object of UPPER_SNAKE_CASE string values`);
  return result.output;
}
