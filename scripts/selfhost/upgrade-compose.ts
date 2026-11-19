/** Compose inputs at two revisions, shared by upgrade planning and its regression tests. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { REPO_ROOT } from './deploy-steps.js';
import { COMPOSE_PATH, type ComposeOverlay } from './image-rebuilds.js';

/**
 * True when the diff touches a compose input: a non-README file under deploy/selfhost/, or any
 * compose file the box selects (COMPOSE_FILE may list one elsewhere in the repository).
 */
export function composeInputsChanged(changed: readonly string[], composeFiles: readonly string[]) {
  const selected = new Set(composeFiles.map((file) => relative(REPO_ROOT, resolve(file))));
  return changed.some(
    (f) => (f.startsWith('deploy/selfhost/') && !f.endsWith('.md')) || selected.has(f)
  );
}

/**
 * Every compose file the box selects other than docker-compose.yml, at both refs, for
 * imageRebuilds: a tracked file is read from git at each ref; a file git does not have (an
 * operator's untracked overlay, or one outside the repository) is the same at both, so it is read
 * from disk once.
 */
export function composeOverlays(
  composeFiles: readonly string[],
  from: string,
  to: string,
  fileAt: (ref: string, path: string) => string | null
): ComposeOverlay[] {
  return composeFiles
    .map((file) => ({ file, rel: relative(REPO_ROOT, resolve(file)).split(/[\\/]/).join('/') }))
    .filter(({ rel }) => rel !== COMPOSE_PATH)
    .map(({ file, rel }) => {
      const inRepo = !rel.startsWith('../') && !isAbsolute(rel);
      const atFrom = inRepo ? fileAt(from, rel) : null;
      const atTo = inRepo ? fileAt(to, rel) : null;
      if (atFrom !== null || atTo !== null) return { from: atFrom, to: atTo };
      const onDisk = existsSync(file) ? readFileSync(file, 'utf8') : null;
      return { from: onDisk, to: onDisk };
    });
}
/** Generated env files are compose inputs, even when the compose source did not change. */
const GENERATED_STATE_FILE_SUFFIX = '.env';
export function stateFingerprint(stateDir: string): string {
  const hash = createHash('sha256');
  if (!existsSync(stateDir)) return '';
  for (const name of readdirSync(stateDir).sort()) {
    if (!name.endsWith(GENERATED_STATE_FILE_SUFFIX)) continue;
    try {
      hash.update(name).update(readFileSync(join(stateDir, name)));
    } catch {
      // a directory or unreadable entry is not a compose input
    }
  }
  return hash.digest('hex');
}
