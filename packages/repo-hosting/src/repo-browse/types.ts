import type {
  RepoBranchesResponse,
  RepoCompareResponse,
  RepoFileContent,
  RepoTreeResponse,
} from '@simple-agent-manager/shared';

/**
 * Provider-agnostic read-only browser over a project's remote git repository.
 * Implemented by the GitHub REST provider and the Artifacts isomorphic-git
 * provider. Resolved per-project from `project.repoProvider` via
 * `resolveRepoBrowser()`. All methods are read-only and operate against the
 * remote — no workspace/VM is involved.
 */
export interface RepoBrowser {
  /** List branches; the default branch is marked and surfaced first. */
  listBranches(): Promise<RepoBranchesResponse>;

  /** Full recursive tree at `ref` (web derives directory nav + filename search). */
  listTree(ref: string): Promise<RepoTreeResponse>;

  /**
   * File content at `ref`/`path`. Text under the inline cap is returned as
   * `content`; binary or oversized files return `content: null` with `rawUrl`
   * set for the caller to stream raw bytes.
   */
  getFile(ref: string, path: string): Promise<RepoFileContent>;

  /** Raw bytes of a file at `ref`/`path` (for images, binary, oversized). */
  getRawFile(ref: string, path: string): Promise<{ bytes: Uint8Array; contentType: string }>;

  /** Changed files (with unified-diff patches) comparing `head` against `base`. */
  compare(base: string, head: string): Promise<RepoCompareResponse>;
}
