// =============================================================================
// Repo Browse — remote-branch git browser + diff (GitHub + Artifacts)
// Provider-agnostic types shared by the API (RepoBrowser services) and the web
// ProjectFiles page. Read-only browsing/diffing of a project's remote repo by
// branch, without a running workspace. See idea 01KWY7MR2G2TV0YCDE1R333NF7.
// =============================================================================

/** A branch of the project's remote repository. */
export interface RepoBranch {
  name: string;
  /** True for the repository's default branch (surfaced first in selectors). */
  isDefault: boolean;
}

export interface RepoBranchesResponse {
  branches: RepoBranch[];
  /** True when the branch list hit the provider/config safety cap and is partial. */
  truncated: boolean;
}

/** A single entry in a directory/tree listing. */
export interface RepoTreeEntry {
  /** Repo-relative path (POSIX, no leading slash). */
  path: string;
  /** Basename of the entry. */
  name: string;
  type: 'tree' | 'blob';
  /** Byte size for blobs; null/undefined for trees. */
  size?: number | null;
}

export interface RepoTreeResponse {
  ref: string;
  /** Directory this listing is scoped to ('' or '.' = repo root). */
  path: string;
  entries: RepoTreeEntry[];
  /** True when the provider truncated the tree (e.g. GitHub >100k entries / 7MB). */
  truncated: boolean;
}

/** File content at a ref. Text is returned inline; binary/oversized is served via rawUrl. */
export interface RepoFileContent {
  ref: string;
  path: string;
  size: number;
  isBinary: boolean;
  /** True when the file exceeds the inline size cap; use rawUrl to download. */
  tooLarge: boolean;
  /** UTF-8 text content when the file is inline-able text; null for binary/oversized. */
  content: string | null;
  /** URL to fetch raw bytes (images, binary, oversized) through the API proxy. */
  rawUrl: string | null;
}

export type RepoCompareFileStatus = 'added' | 'modified' | 'removed' | 'renamed';

/** One changed file in a base...head comparison. */
export interface RepoCompareFile {
  path: string;
  /** For renames, the previous path (provider-permitting). */
  previousPath?: string;
  status: RepoCompareFileStatus;
  additions: number;
  deletions: number;
  /** Unified-diff string (feeds the shared DiffRenderer). Absent when omitted/too large. */
  patch: string | null;
  /** True when the provider omitted the patch because the file diff is too large. */
  patchTruncated: boolean;
  /** True when this file's content is binary (no textual diff). */
  isBinary: boolean;
}

/** Result of comparing a head branch against a base (default) branch. */
export interface RepoCompareResponse {
  base: string;
  head: string;
  files: RepoCompareFile[];
  /** Totals across all changed files. */
  totalAdditions: number;
  totalDeletions: number;
  filesChanged: number;
  /** True when the provider truncated the changed-file set (very large diffs). */
  truncated: boolean;
}
