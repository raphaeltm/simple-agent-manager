import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { GitHubRepoBrowser } from '../../../src/services/repo-browse/github';

const githubApp = vi.hoisted(() => ({
  getInstallationToken: vi.fn(),
  getRepositoryBranches: vi.fn(),
}));

vi.mock('../../../src/services/github-app', () => githubApp);

function makeBrowser(env: Partial<Env> = {}): GitHubRepoBrowser {
  return new GitHubRepoBrowser('octo', 'repo', 'main', 'inst-1', env as Env);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  githubApp.getInstallationToken.mockResolvedValue({ token: 'tok', expiresAt: '' });
});

describe('GitHubRepoBrowser.listBranches', () => {
  it('marks the default branch and reports truncation against the cap', async () => {
    githubApp.getRepositoryBranches.mockResolvedValue([{ name: 'main' }, { name: 'feat' }]);
    const res = await makeBrowser({ MAX_BRANCHES_PER_REPO: '2' }).listBranches();
    expect(res.branches).toEqual([
      { name: 'main', isDefault: true },
      { name: 'feat', isDefault: false },
    ]);
    expect(res.truncated).toBe(true); // length (2) >= cap (2)
  });

  it('is not truncated when under the cap / no cap set', async () => {
    githubApp.getRepositoryBranches.mockResolvedValue([{ name: 'main' }]);
    expect((await makeBrowser().listBranches()).truncated).toBe(false);
  });
});

describe('GitHubRepoBrowser.listTree', () => {
  it('maps blobs/trees, skips submodules, and surfaces truncation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          tree: [
            { path: 'src', type: 'tree' },
            { path: 'src/a.ts', type: 'blob', size: 10 },
            { path: 'vendor', type: 'commit' }, // submodule — must be skipped
          ],
          truncated: true,
        })
      )
    );
    const res = await makeBrowser().listTree('main');
    expect(res.truncated).toBe(true);
    expect(res.entries).toEqual([
      { path: 'src', name: 'src', type: 'tree', size: null },
      { path: 'src/a.ts', name: 'a.ts', type: 'blob', size: 10 },
    ]);
  });
});

describe('GitHubRepoBrowser.getFile', () => {
  it('inlines small text content (base64 → utf8)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({ type: 'file', size: 5, encoding: 'base64', content: btoa('hello') })
      )
    );
    const f = await makeBrowser().getFile('main', 'a.txt');
    expect(f).toMatchObject({ content: 'hello', isBinary: false, tooLarge: false, size: 5 });
  });

  it('flags binary content (NUL byte) with null content', async () => {
    const bin = btoa(String.fromCharCode(1, 0, 2, 3));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ type: 'file', size: 4, encoding: 'base64', content: bin }))
    );
    const f = await makeBrowser().getFile('main', 'x.bin');
    expect(f.isBinary).toBe(true);
    expect(f.content).toBeNull();
  });

  it('flags oversized files as tooLarge without inlining', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ type: 'file', size: 5, encoding: 'base64', content: btoa('hello') }))
    );
    const f = await makeBrowser({ REPO_BROWSE_MAX_INLINE_BYTES: '2' }).getFile('main', 'big.txt');
    expect(f.tooLarge).toBe(true);
    expect(f.content).toBeNull();
  });
});

describe('GitHubRepoBrowser.compare', () => {
  it('maps status, detects binary, computes totals and patch truncation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          files: [
            { filename: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@' },
            { filename: 'img.png', status: 'added', additions: 0, deletions: 0 }, // binary (no patch, 0/0)
            { filename: 'huge.txt', status: 'modified', additions: 500, deletions: 10 }, // patch omitted → truncated
            { filename: 'new.ts', status: 'renamed', previous_filename: 'old.ts', additions: 0, deletions: 0, patch: '@@ x @@' },
          ],
        })
      )
    );
    const res = await makeBrowser().compare('main', 'feat');
    const byPath = Object.fromEntries(res.files.map((f) => [f.path, f]));
    expect(byPath['a.ts']).toMatchObject({ status: 'modified', patch: '@@ -1 +1 @@', isBinary: false, patchTruncated: false });
    expect(byPath['img.png']).toMatchObject({ status: 'added', isBinary: true, patch: null });
    expect(byPath['huge.txt']).toMatchObject({ patchTruncated: true, isBinary: false, patch: null });
    expect(byPath['new.ts']).toMatchObject({ status: 'renamed', previousPath: 'old.ts' });
    expect(res.totalAdditions).toBe(502);
    expect(res.totalDeletions).toBe(11);
    expect(res.filesChanged).toBe(4);
  });
});

describe('GitHubRepoBrowser.getRawFile', () => {
  it('returns raw bytes and content-type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([9, 8, 7]), { headers: { 'content-type': 'image/png' } })
      )
    );
    const { bytes, contentType } = await makeBrowser().getRawFile('main', 'x.png');
    expect(Array.from(bytes)).toEqual([9, 8, 7]);
    expect(contentType).toBe('image/png');
  });
});
