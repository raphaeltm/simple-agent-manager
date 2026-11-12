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
import type { GitLabRepositoryMetadata } from '../gitlab';
import {
  compareGitLabRefs,
  getGitLabFile,
  getGitLabRawFile,
  getGitLabTree,
  listGitLabBranches,
  requireGitLabUserAccessTokenForOwner,
} from '../gitlab';
import type { RepoBrowser } from './types';
import { basename, isBinaryBytes, maxInlineBytes } from './util';

function mapCompareStatus(input: {
  newFile?: boolean;
  deletedFile?: boolean;
  renamedFile?: boolean;
}): RepoCompareFileStatus {
  if (input.newFile) return 'added';
  if (input.deletedFile) return 'removed';
  if (input.renamedFile) return 'renamed';
  return 'modified';
}

export class GitLabRepoBrowser implements RepoBrowser {
  private tokenPromise: Promise<string> | null = null;

  constructor(
    private readonly metadata: GitLabRepositoryMetadata,
    private readonly userId: string,
    private readonly env: Env
  ) {}

  private async token(): Promise<string> {
    if (!this.tokenPromise) {
      this.tokenPromise = requireGitLabUserAccessTokenForOwner(
        this.env,
        this.userId,
        'gitlab-repo-browse'
      );
    }
    return this.tokenPromise;
  }

  async listBranches(): Promise<RepoBranchesResponse> {
    const branches = await listGitLabBranches(
      this.env,
      await this.token(),
      this.metadata.gitlabProjectId
    );
    return {
      branches: branches.map((branch) => ({
        name: branch.name,
        isDefault: branch.name === this.metadata.defaultBranch || branch.isDefault,
      })),
      truncated: false,
    };
  }

  async listTree(ref: string): Promise<RepoTreeResponse> {
    const result = await getGitLabTree(
      this.env,
      await this.token(),
      this.metadata.gitlabProjectId,
      ref
    );
    const entries: RepoTreeEntry[] = [];
    for (const entry of result.entries) {
      if (entry.type !== 'blob' && entry.type !== 'tree') continue;
      entries.push({
        path: entry.path,
        name: entry.name || basename(entry.path),
        type: entry.type === 'tree' ? 'tree' : 'blob',
        size: entry.type === 'blob' ? (entry.size ?? null) : null,
      });
    }
    return { ref, path: '', entries, truncated: result.truncated };
  }

  async getFile(ref: string, path: string): Promise<RepoFileContent> {
    const file = await getGitLabFile(
      this.env,
      await this.token(),
      this.metadata.gitlabProjectId,
      ref,
      path
    );
    const base: RepoFileContent = {
      ref,
      path,
      size: file.size,
      isBinary: false,
      tooLarge: false,
      content: null,
      rawUrl: null,
    };
    if (file.size > maxInlineBytes(this.env) || file.encoding !== 'base64' || !file.content) {
      return { ...base, tooLarge: true };
    }
    const bytes = Uint8Array.from(atob(file.content.replace(/\n/g, '')), (ch) => ch.charCodeAt(0));
    if (isBinaryBytes(bytes)) {
      return { ...base, isBinary: true };
    }
    return { ...base, content: new TextDecoder().decode(bytes) };
  }

  async getRawFile(ref: string, path: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    return getGitLabRawFile(this.env, await this.token(), this.metadata.gitlabProjectId, ref, path);
  }

  async compare(base: string, head: string): Promise<RepoCompareResponse> {
    const result = await compareGitLabRefs(
      this.env,
      await this.token(),
      this.metadata.gitlabProjectId,
      base,
      head
    );
    const files: RepoCompareFile[] = (result.diffs ?? []).map((diff) => {
      const patch = diff.diff ?? null;
      return {
        path: diff.new_path,
        previousPath: diff.renamed_file ? diff.old_path : undefined,
        status: mapCompareStatus({
          newFile: diff.new_file,
          deletedFile: diff.deleted_file,
          renamedFile: diff.renamed_file,
        }),
        additions: 0,
        deletions: 0,
        patch,
        patchTruncated: Boolean(diff.too_large || diff.collapsed),
        isBinary: Boolean(diff.binary),
      };
    });
    return {
      base,
      head,
      files,
      totalAdditions: 0,
      totalDeletions: 0,
      filesChanged: files.length,
      truncated: files.some((file) => file.patchTruncated),
    };
  }
}
