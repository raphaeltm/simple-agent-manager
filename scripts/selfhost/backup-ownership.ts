/** Public filesystem identities for an encrypted backup created by this installation. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { CreatedResource } from '../../deploy/selfhost/created-resources.mjs';

export function backupOwnership(path: string): Record<string, string> {
  if (!isAbsolute(path) || realpathSync(path) !== resolve(path))
    throw new Error('Backup ownership requires an exact directory without symlinks');
  const directory = lstatSync(path);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (process.getuid !== undefined && directory.uid !== process.getuid())
  )
    throw new Error('Backup directory ownership cannot be verified');
  const fd = openSync(
    join(path, '.sam-backup-manifest'),
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const manifest = fstatSync(fd);
    if (
      !manifest.isFile() ||
      manifest.nlink !== 1 ||
      manifest.size < 36 ||
      (process.getuid !== undefined && manifest.uid !== process.getuid())
    )
      throw new Error('Backup encrypted inventory ownership cannot be verified');
    const magic = Buffer.alloc(8);
    if (readSync(fd, magic, 0, magic.length, 0) !== magic.length || magic.toString() !== 'SAMBAK01')
      throw new Error('Backup has no encrypted inventory');
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < manifest.size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, manifest.size - offset), offset);
      if (count === 0) throw new Error('Backup encrypted inventory changed');
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    const liveDirectory = lstatSync(path);
    const liveManifest = lstatSync(join(path, '.sam-backup-manifest'));
    if (
      realpathSync(path) !== resolve(path) ||
      liveDirectory.dev !== directory.dev ||
      liveDirectory.ino !== directory.ino ||
      liveManifest.dev !== manifest.dev ||
      liveManifest.ino !== manifest.ino ||
      liveManifest.size !== manifest.size ||
      liveManifest.nlink !== 1
    )
      throw new Error('Backup directory or encrypted inventory changed during ownership proof');
    const proof = {
      device: String(directory.dev),
      inode: String(directory.ino),
      manifestDevice: String(manifest.dev),
      manifestInode: String(manifest.ino),
      manifestHash: hash.digest('hex'),
    };
    return { ...proof, identity: createHash('sha256').update(JSON.stringify(proof)).digest('hex') };
  } finally {
    closeSync(fd);
  }
}

export function assertBackupOwnership(path: string, entry?: CreatedResource): void {
  if (
    !entry ||
    entry.cloud !== 'box' ||
    entry.kind !== 'backup' ||
    entry.name !== path ||
    entry.createdBy !== 'backup' ||
    entry.action !== 'created' ||
    entry.removedAt
  )
    throw new Error('Refused: backup has no active creation receipt');
  const current = backupOwnership(path);
  if (Object.entries(current).some(([name, value]) => entry.attributes?.[name] !== value))
    throw new Error(
      'Refused: backup path or encrypted inventory identity changed or was never recorded'
    );
}
