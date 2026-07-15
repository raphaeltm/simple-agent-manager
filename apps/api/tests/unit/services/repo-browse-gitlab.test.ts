import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { GitLabRepositoryMetadata } from '../../../src/services/gitlab';
import { GitLabRepoBrowser } from '../../../src/services/repo-browse/gitlab';

const gitlab = vi.hoisted(() => ({
  compareGitLabRefs: vi.fn(),
  getGitLabFile: vi.fn(),
  getGitLabRawFile: vi.fn(),
  getGitLabTree: vi.fn(),
  listGitLabBranches: vi.fn(),
  requireGitLabUserAccessTokenForOwner: vi.fn(),
}));

vi.mock('../../../src/services/gitlab', () => gitlab);

const metadata: GitLabRepositoryMetadata = {
  host: 'gitlab.com',
  gitlabProjectId: 123,
  pathWithNamespace: 'group/project',
  webUrl: 'https://gitlab.com/group/project',
  httpUrlToRepo: 'https://gitlab.com/group/project.git',
  defaultBranch: 'main',
};

function makeBrowser(env: Partial<Env> = {}): GitLabRepoBrowser {
  return new GitLabRepoBrowser(metadata, 'user-1', env as Env);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  gitlab.requireGitLabUserAccessTokenForOwner.mockResolvedValue('gl_token');
});

describe('GitLabRepoBrowser.listBranches', () => {
  it('uses the user token and marks the default branch', async () => {
    gitlab.listGitLabBranches.mockResolvedValue([
      { name: 'main', isDefault: false },
      { name: 'feature', isDefault: false },
    ]);

    const res = await makeBrowser().listBranches();

    expect(gitlab.requireGitLabUserAccessTokenForOwner).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'gitlab-repo-browse'
    );
    expect(gitlab.listGitLabBranches).toHaveBeenCalledWith(expect.anything(), 'gl_token', 123);
    expect(res).toEqual({
      branches: [
        { name: 'main', isDefault: true },
        { name: 'feature', isDefault: false },
      ],
      truncated: false,
    });
  });
});

describe('GitLabRepoBrowser.listTree', () => {
  it('maps blobs and trees while skipping unsupported entry types', async () => {
    gitlab.getGitLabTree.mockResolvedValue({
      truncated: true,
      entries: [
        { path: 'src', name: 'src', type: 'tree' },
        { path: 'src/app.ts', name: 'app.ts', type: 'blob', size: 42 },
        { path: 'vendor', name: 'vendor', type: 'commit' },
      ],
    });

    const res = await makeBrowser().listTree('main');

    expect(res).toEqual({
      ref: 'main',
      path: '',
      entries: [
        { path: 'src', name: 'src', type: 'tree', size: null },
        { path: 'src/app.ts', name: 'app.ts', type: 'blob', size: 42 },
      ],
      truncated: true,
    });
  });
});

describe('GitLabRepoBrowser.getFile', () => {
  it('inlines small base64 text content', async () => {
    gitlab.getGitLabFile.mockResolvedValue({
      file_path: 'README.md',
      size: 5,
      encoding: 'base64',
      content: btoa('hello'),
    });

    const file = await makeBrowser().getFile('main', 'README.md');

    expect(file).toMatchObject({
      ref: 'main',
      path: 'README.md',
      size: 5,
      isBinary: false,
      tooLarge: false,
      content: 'hello',
    });
  });

  it('does not inline oversized content', async () => {
    gitlab.getGitLabFile.mockResolvedValue({
      file_path: 'large.txt',
      size: 10,
      encoding: 'base64',
      content: btoa('0123456789'),
    });

    const file = await makeBrowser({ REPO_BROWSE_MAX_INLINE_BYTES: '2' }).getFile(
      'main',
      'large.txt'
    );

    expect(file.tooLarge).toBe(true);
    expect(file.content).toBeNull();
  });
});

describe('GitLabRepoBrowser.compare', () => {
  it('maps GitLab diffs into the provider-neutral compare shape', async () => {
    gitlab.compareGitLabRefs.mockResolvedValue({
      diffs: [
        { old_path: 'a.ts', new_path: 'a.ts', diff: '@@ x @@' },
        { old_path: 'old.ts', new_path: 'new.ts', renamed_file: true, diff: '@@ y @@' },
        { old_path: 'gone.ts', new_path: 'gone.ts', deleted_file: true, too_large: true },
        { old_path: 'img.png', new_path: 'img.png', new_file: true, binary: true },
      ],
    });

    const res = await makeBrowser().compare('main', 'feature');

    expect(res.files).toEqual([
      expect.objectContaining({ path: 'a.ts', status: 'modified', patch: '@@ x @@' }),
      expect.objectContaining({
        path: 'new.ts',
        previousPath: 'old.ts',
        status: 'renamed',
      }),
      expect.objectContaining({ path: 'gone.ts', status: 'removed', patchTruncated: true }),
      expect.objectContaining({ path: 'img.png', status: 'added', isBinary: true }),
    ]);
    expect(res.filesChanged).toBe(4);
    expect(res.truncated).toBe(true);
  });
});
