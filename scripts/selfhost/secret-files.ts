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
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';

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

/**
 * Parses a dotenv file: `NAME=value`, `export NAME=value`, `#` comments, `'literal'`, and
 * `"double"` values with `\n` escapes that may also span lines (multi-line PEM keys).
 * No interpolation. Throws on any line it cannot parse, naming the line but never its value.
 */
export function parseDotenv(text: string, source: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`${source}:${i + 1}: expected NAME=value`);
    const [, name = '', matchedRest = ''] = match;
    let rest = matchedRest;
    let value: string;
    if (rest.startsWith('"')) {
      const lineNo = i + 1;
      let body = rest.slice(1);
      let end = closingQuoteIndex(body);
      // A double-quoted value may span lines (a PEM pasted as-is).
      while (end === -1) {
        i += 1;
        if (i >= lines.length) throw new Error(`${source}:${lineNo}: unterminated double quote`);
        body += `\n${lines[i]}`;
        end = closingQuoteIndex(body);
      }
      const trailing = body.slice(end + 1).trim();
      if (trailing !== '' && !trailing.startsWith('#')) {
        throw new Error(`${source}:${lineNo}: unexpected text after closing quote`);
      }
      value = unescapeDoubleQuoted(body.slice(0, end));
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end === -1) throw new Error(`${source}:${i + 1}: unterminated single quote`);
      value = rest.slice(1, end);
    } else {
      const hash = rest.search(/\s#/);
      if (hash !== -1) rest = rest.slice(0, hash);
      value = rest.trim();
    }
    values[name] = value;
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
