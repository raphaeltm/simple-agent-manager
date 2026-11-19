import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareBackupParent } from './backup-destination';

let root: string;
beforeEach(() => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(resolve('.tmp/backup-parent-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('operator backup destination parent', () => {
  it('preserves existing mode1777 and ownership and creates only private new child directories', () => {
    chmodSync(root, 0o1777);
    const before = statSync(root);
    prepareBackupParent(join(root, 'new/backups/snapshot'));
    const after = statSync(root);
    expect(after.mode & 0o7777).toBe(0o1777);
    expect(after.uid).toBe(before.uid);
    expect(after.ino).toBe(before.ino);
    expect(statSync(join(root, 'new/backups')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'new/backups')).uid).toBe(process.getuid?.());
  });
  it('rejects symlink parents before changing the pointed-to directory', () => {
    const actual = join(root, 'actual');
    mkdirSync(actual, { mode: 0o755 });
    const before = statSync(actual);
    symlinkSync(actual, join(root, 'linked'));
    expect(() => prepareBackupParent(join(root, 'linked/nested/snapshot'))).toThrow(
      'without symlinks'
    );
    expect(statSync(actual).mode & 0o777).toBe(before.mode & 0o777);
    expect(statSync(actual).ino).toBe(before.ino);
  });
  it.skipIf(process.getuid?.() === statSync('/tmp').uid)(
    'does not claim or chmod the actual foreign-owned temporary directory',
    () => {
      const before = statSync('/tmp');
      const absent = join('/tmp', `sam-parent-control-no-write-${process.pid}-${Date.now()}`);
      expect(existsSync(absent)).toBe(false);
      prepareBackupParent(absent);
      const after = statSync('/tmp');
      expect(after.uid).toBe(before.uid);
      expect(after.mode).toBe(before.mode);
      expect(existsSync(absent)).toBe(false);
    }
  );
  it.skipIf(process.getuid?.() !== 0)(
    'preserves a foreign-owned existing parent instead of claiming it',
    () => {
      chownSync(root, 65534, 65534);
      chmodSync(root, 0o1777);
      prepareBackupParent(join(root, 'owned-child/snapshot'));
      expect(statSync(root).uid).toBe(65534);
      expect(statSync(root).mode & 0o7777).toBe(0o1777);
      expect(statSync(join(root, 'owned-child')).uid).toBe(0);
    }
  );
});
