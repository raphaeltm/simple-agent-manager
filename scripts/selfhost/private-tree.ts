/** Cleanup of newly created private operation scratch, including copied read-only directories. */
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { assertOperatorExecution } from './operator-only';

export function removePrivateTree(path: string): void {
  assertOperatorExecution();
  const root = lstatSync(path, { throwIfNoEntry: false });
  if (!root) return;
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error('Private scratch cleanup requires its original directory');
  const writable = (directory: string): void => {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    if (process.getuid !== undefined && info.uid !== process.getuid())
      throw new Error('Private scratch cleanup refuses a foreign-owned directory');
    if ((info.mode & 0o700) !== 0o700) chmodSync(directory, info.mode | 0o700);
    for (const entry of readdirSync(directory)) writable(join(directory, entry));
  };
  writable(path);
  rmSync(path, { recursive: true, force: true });
}
