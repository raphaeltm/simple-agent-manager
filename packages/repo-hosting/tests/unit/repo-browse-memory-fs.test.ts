import { describe, expect, it } from 'vitest';

import { MemoryFS } from '../../../src/services/repo-browse/memory-fs';

describe('MemoryFS', () => {
  it('exposes a promises property pointing at itself (isomorphic-git contract)', () => {
    const fs = new MemoryFS();
    expect(fs.promises).toBe(fs);
  });

  it('writes and reads a file (bytes and utf8)', async () => {
    const fs = new MemoryFS();
    await fs.mkdir('/repo', { recursive: true });
    await fs.writeFile('/repo/a.txt', 'hello');
    expect(new TextDecoder().decode(await fs.readFile('/repo/a.txt') as Uint8Array)).toBe('hello');
    expect(await fs.readFile('/repo/a.txt', 'utf8')).toBe('hello');
  });

  it('mkdir non-recursive requires an existing parent', async () => {
    const fs = new MemoryFS();
    await expect(fs.mkdir('/a/b/c')).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.mkdir('/a');
    await fs.mkdir('/a/b');
    await fs.mkdir('/a/b/c');
    expect((await fs.stat('/a/b/c')).isDirectory()).toBe(true);
  });

  it('mkdir recursive creates intermediate dirs and is idempotent', async () => {
    const fs = new MemoryFS();
    await fs.mkdir('/x/y/z', { recursive: true });
    await fs.mkdir('/x/y/z', { recursive: true }); // idempotent
    expect((await fs.stat('/x/y')).isDirectory()).toBe(true);
    await expect(fs.mkdir('/x/y')).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('readdir lists only immediate children', async () => {
    const fs = new MemoryFS();
    await fs.mkdir('/repo', { recursive: true });
    await fs.mkdir('/repo/sub', { recursive: true });
    await fs.writeFile('/repo/a.txt', 'a');
    await fs.writeFile('/repo/sub/b.txt', 'b');
    const names = (await fs.readdir('/repo')).sort();
    expect(names).toEqual(['a.txt', 'sub']);
  });

  it('stat reports size and type; readFile on a dir throws EISDIR', async () => {
    const fs = new MemoryFS();
    await fs.mkdir('/repo', { recursive: true });
    await fs.writeFile('/repo/f', new Uint8Array([1, 2, 3, 4]));
    const st = await fs.stat('/repo/f');
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(4);
    await expect(fs.readFile('/repo')).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('unlink removes a file; missing paths throw ENOENT', async () => {
    const fs = new MemoryFS();
    await fs.mkdir('/repo', { recursive: true });
    await fs.writeFile('/repo/f', 'x');
    await fs.unlink('/repo/f');
    await expect(fs.readFile('/repo/f')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.unlink('/repo/missing')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports symlinks: lstat sees the link, stat resolves it', async () => {
    const fs = new MemoryFS();
    await fs.mkdir('/repo', { recursive: true });
    await fs.writeFile('/repo/target', 'data');
    await fs.symlink('target', '/repo/link');
    expect((await fs.lstat('/repo/link')).isSymbolicLink()).toBe(true);
    expect(await fs.readlink('/repo/link')).toBe('target');
    expect((await fs.stat('/repo/link')).isFile()).toBe(true);
  });

  it('normalizes . and .. path segments', async () => {
    const fs = new MemoryFS();
    await fs.mkdir('/repo', { recursive: true });
    await fs.writeFile('/repo/./a.txt', 'A');
    expect(await fs.readFile('/repo/sub/../a.txt', 'utf8')).toBe('A');
  });
});
