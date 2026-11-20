/**
 * The local bundle store makes a new or removed bundle name durable before it returns (Codex P1 on
 * #2933): fsyncing the temp file does not commit the rename, so a power loss after a seal could
 * drop the bundle the deploy had already published while migrate removed the plaintext files.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ops: string[] = [];
const fdPaths = new Map<number, string>();

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    openSync: (path: string, ...rest: unknown[]) => {
      const fd = (real.openSync as (...a: unknown[]) => number)(path, ...rest);
      fdPaths.set(fd, String(path));
      return fd;
    },
    fsyncSync: (fd: number) => {
      ops.push(`fsync ${fdPaths.get(fd)}`);
      real.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      ops.push(`rename ${to}`);
      real.renameSync(from, to);
    },
    rmSync: (path: string, options?: Parameters<typeof real.rmSync>[1]) => {
      ops.push(`rm ${path}`);
      real.rmSync(path, options);
    },
  };
});

const { openBundleStore } = await import('../../deploy/selfhost/key-agent/bundle-store.ts');

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-bundle-store-'));
  dir = join(root, 'bundles');
  ops.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ID = 'ab'.repeat(16);
const bundle = { bundleId: ID, createdAt: new Date(0).toISOString() } as never;

describe('local bundle store durability', () => {
  it('fsyncs the directory after renaming a new bundle into place', async () => {
    const store = openBundleStore({ dir });
    await store.write(bundle);
    const target = join(dir, `${ID}.json`);
    const renamed = ops.indexOf(`rename ${target}`);
    expect(renamed).toBeGreaterThan(-1);
    // Liveness: the temp file itself was fsynced before the rename.
    expect(ops.slice(0, renamed).some((op) => op.startsWith('fsync ') && op.endsWith('.tmp'))).toBe(
      true
    );
    expect(ops.slice(renamed + 1)).toContain(`fsync ${dir}`);
    expect(await store.listIds()).toEqual([ID]);
  });

  it('fsyncs the directory after removing a bundle', async () => {
    const store = openBundleStore({ dir });
    await store.write(bundle);
    ops.length = 0;
    await store.remove(ID);
    const target = join(dir, `${ID}.json`);
    expect(ops).toEqual([`rm ${target}`, `fsync ${dir}`]);
    expect(await store.listIds()).toEqual([]);
  });
});
