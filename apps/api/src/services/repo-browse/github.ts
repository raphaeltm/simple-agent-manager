import type {
  RepoBranchesResponse,
  RepoCompareFile,
  RepoCompareFileStatus,
  RepoCompareResponse,
  RepoFileContent,
  RepoTreeEntry,
  RepoTreeResponse,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { getInstallationToken, getRepositoryBranches } from '../github-app';
import type { RepoBrowser } from './types';
import { basename, isBinaryBytes, maxInlineBytes } from './util';

/** GitHub's compare API caps the changed-file list; treat >= this as truncated. */
const GITHUB_COMPARE_FILE_CAP = 300;

/** Encode a repo-relative path for a GitHub URL, preserving '/' separators. */
function encodePath(path: string): string {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

function mapCompareStatus(status: string): RepoCompareFileStatus {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'renamed':
      return 'renamed';
    // 'modified' | 'changed' | 'copied' | 'unchanged' → treat as modified
    default:
      return 'modified';
  }
}

/**
 * GitHub REST implementation of {@link RepoBrowser}. Reads repo content through
 * the project's GitHub App installation token. Callers MUST have already passed
 * the user∩app access gate (`requireRepositoryUserAccess`) before constructing
 * this — the installation token is app-scoped and must not bypass a user's
 * revoked repo access (see PR #1236/#1238 leak class).
 */
export class GitHubRepoBrowser implements RepoBrowser {
  private tokenPromise: Promise<string> | null = null;

  constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly defaultBranch: string,
    private readonly externalInstallationId: string,
    private readonly env: Env
  ) {}

  private async token(): Promise<string> {
    if (!this.tokenPromise) {
      this.tokenPromise = getInstallationToken(this.externalInstallationId, this.env).then(
        (r) => r.token
      );
    }
    return this.tokenPromise;
  }

  private async gh(pathAndQuery: string, accept = 'application/vnd.github+json'): Promise<Response> {
    const token = await this.token();
    return fetch(`https://api.github.com${pathAndQuery}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Simple-Agent-Manager',
      },
    });
  }

  private repoPath(): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  async listBranches(): Promise<RepoBranchesResponse> {
    const branches = await getRepositoryBranches(
      this.externalInstallationId,
      this.owner,
      this.repo,
      this.env,
      this.defaultBranch
    );
    const cap = parseInt(this.env.MAX_BRANCHES_PER_REPO || '', 10);
    return {
      branches: branches.map((b) => ({ name: b.name, isDefault: b.name === this.defaultBranch })),
      truncated: Number.isFinite(cap) && cap > 0 ? branches.length >= cap : false,
    };
  }

  async listTree(ref: string): Promise<RepoTreeResponse> {
    const res = await this.gh(
      `${this.repoPath()}/git/trees/${encodeURIComponent(ref)}?recursive=1`
    );
    if (!res.ok) {
      throw new Error(`GitHub tree fetch failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      tree?: Array<{ path: string; type: string; size?: number }>;
      truncated?: boolean;
    };
    const entries: RepoTreeEntry[] = [];
    for (const t of data.tree ?? []) {
      if (t.type !== 'blob' && t.type !== 'tree') continue; // skip submodules ('commit')
      entries.push({
        path: t.path,
        name: basename(t.path),
        type: t.type === 'tree' ? 'tree' : 'blob',
        size: t.type === 'blob' ? (t.size ?? null) : null,
      });
    }
    return { ref, path: '', entries, truncated: Boolean(data.truncated) };
  }

  async getFile(ref: string, path: string): Promise<RepoFileContent> {
    const res = await this.gh(
      `${this.repoPath()}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
    );
    if (res.status === 404) {
      throw new Error('File not found');
    }
    if (!res.ok) {
      throw new Error(`GitHub file fetch failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      type?: string;
      size?: number;
      content?: string;
      encoding?: string;
    };
    if (data.type !== 'file') {
      throw new Error('Path is not a file');
    }
    const size = data.size ?? 0;
    const cap = maxInlineBytes(this.env);
    const base: RepoFileContent = {
      ref,
      path,
      size,
      isBinary: false,
      tooLarge: false,
      content: null,
      rawUrl: null,
    };
    // GitHub omits inline content for files >1MB; also enforce our own cap.
    if (size > cap || data.encoding !== 'base64' || !data.content) {
      return { ...base, tooLarge: true };
    }
    const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, '')), (ch) => ch.charCodeAt(0));
    if (isBinaryBytes(bytes)) {
      return { ...base, isBinary: true };
    }
    return { ...base, content: new TextDecoder().decode(bytes) };
  }

  async getRawFile(ref: string, path: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.gh(
      `${this.repoPath()}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      'application/vnd.github.raw'
    );
    if (res.status === 404) {
      throw new Error('File not found');
    }
    if (!res.ok) {
      throw new Error(`GitHub raw fetch failed: ${res.status}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    return { bytes, contentType };
  }

  async compare(base: string, head: string): Promise<RepoCompareResponse> {
    const res = await this.gh(
      `${this.repoPath()}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
    );
    if (!res.ok) {
      throw new Error(`GitHub compare failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      files?: Array<{
        filename: string;
        previous_filename?: string;
        status: string;
        additions?: number;
        deletions?: number;
        patch?: string;
      }>;
    };
    const rawFiles = data.files ?? [];
    const files: RepoCompareFile[] = rawFiles.map((f) => {
      const additions = f.additions ?? 0;
      const deletions = f.deletions ?? 0;
      const hasPatch = typeof f.patch === 'string';
      // GitHub omits `patch` for binary files and for very large text diffs.
      const isBinary = !hasPatch && additions === 0 && deletions === 0;
      return {
        path: f.filename,
        previousPath: f.previous_filename,
        status: mapCompareStatus(f.status),
        additions,
        deletions,
        patch: hasPatch ? (f.patch as string) : null,
        patchTruncated: !hasPatch && !isBinary,
        isBinary,
      };
    });
    return {
      base,
      head,
      files,
      totalAdditions: files.reduce((n, f) => n + f.additions, 0),
      totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
      filesChanged: files.length,
      truncated: files.length >= GITHUB_COMPARE_FILE_CAP,
    };
  }
}
