/** Validate operator-selected destinations without changing permissions on reused directories. */
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function prepareBackupParent(destination: string): void {
  if (lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error('Backup destination must not use symlinks');
  const parent = dirname(resolve(destination));
  const missing: string[] = [];
  let ancestor = parent;
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
    missing.unshift(ancestor);
    ancestor = dirname(ancestor);
  }
  const existing = lstatSync(ancestor);
  if (!existing.isDirectory() || existing.isSymbolicLink() || realpathSync(ancestor) !== ancestor) {
    throw new Error('Backup destination parent must be a directory without symlinks');
  }
  // mkdir's mode applies only to newly-created directories. Never chmod an operator's parent.
  for (const path of missing) {
    mkdirSync(path, { mode: 0o700 });
    const created = lstatSync(path);
    if (
      !created.isDirectory() ||
      created.isSymbolicLink() ||
      (process.getuid !== undefined && created.uid !== process.getuid())
    ) {
      throw new Error('Cannot verify ownership of new backup directory');
    }
  }
}
