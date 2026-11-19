/**
 * Which compose files a box runs with, and which variables docker compose interpolates from them.
 * Compose takes each interpolated variable from the invoking shell before `--env-file`, so the
 * deploy and upgrade must resolve exactly these names the same way (box-settings.ts loadBoxEnv).
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

/**
 * The compose files a box runs with. `COMPOSE_FILE` in .env adds files to the stack, and docker
 * compose reads it only when no `-f` is given: an explicit `-f docker-compose.yml` silently drops
 * every other file, so a recreate loses what they add. Scripted compose calls must therefore pass
 * this whole list. Split on COMPOSE_PATH_SEPARATOR (default `:`, as compose does on Linux);
 * relative entries are resolved against `composeDir`, the directory holding the compose files.
 */
export function composeFilesFor(
  box: Readonly<Record<string, string>>,
  composeDir: string
): string[] {
  const separator = box.COMPOSE_PATH_SEPARATOR || ':';
  const listed = (box.COMPOSE_FILE ?? '')
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return (listed.length > 0 ? listed : ['docker-compose.yml']).map((entry) =>
    isAbsolute(entry) ? entry : resolve(composeDir, entry)
  );
}

/**
 * `$$` (compose's escape for a literal `$`) or one reference: `$NAME`, `${NAME}`, `${NAME:-x}`,
 * `${NAME?err}` and the other `${NAME<op>...}` forms. A nested default (`${A:-${B}}`) is matched
 * again at its own `$`.
 */
const REFERENCE = /\$\$|\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;

/** Every variable a compose file interpolates: compose reads values, not keys or comments. */
export function composeVariableNames(composeText: string): Set<string> {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(REFERENCE)) if (match[1]) names.add(match[1]);
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node !== null && typeof node === 'object') {
      Object.values(node).forEach(visit);
    }
  };
  visit(parseYaml(composeText));
  return names;
}

/**
 * Every variable the box's compose files (composeFilesFor) interpolate. A selected file that does
 * not exist is skipped: docker compose refuses to run with it, so no running value can disagree.
 */
export function composeFileVariables(
  box: Readonly<Record<string, string>>,
  composeDir: string
): Set<string> {
  const names = new Set<string>();
  for (const file of composeFilesFor(box, composeDir)) {
    if (!existsSync(file)) continue;
    for (const name of composeVariableNames(readFileSync(file, 'utf8'))) names.add(name);
  }
  return names;
}
