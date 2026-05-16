import type {
  CreateWorktreeRequest,
  GitBranchListResponse,
  RemoveWorktreeResponse,
  WorktreeInfo,
  WorktreeListResponse,
} from '@simple-agent-manager/shared';
import type { ApiError } from '@simple-agent-manager/shared';

import {
  expectJsonRecord,
  optionalString,
  readResponseJson,
  requireArray,
  requireBoolean,
  requireNumber,
  requireString,
} from '../runtime-validation';
import { API_URL, ApiClientError, request } from './client';

// =============================================================================
// Git Integration (direct VM Agent calls via ws-{id} subdomain)
// =============================================================================

export interface GitFileStatus {
  path: string;
  status: string;
  oldPath?: string;
}

export interface GitStatusData {
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: GitFileStatus[];
}

function parseGitFileStatus(value: unknown, context: string): GitFileStatus {
  const record = expectJsonRecord(value, context);
  return {
    path: requireString(record, 'path', context),
    status: requireString(record, 'status', context),
    ...(optionalString(record, 'oldPath') ? { oldPath: optionalString(record, 'oldPath') } : {}),
  };
}

function parseGitStatusData(record: Record<string, unknown>): GitStatusData {
  return {
    staged: requireArray(record, 'staged', 'git.status').map((value, index) => parseGitFileStatus(value, `git.status.staged[${index}]`)),
    unstaged: requireArray(record, 'unstaged', 'git.status').map((value, index) => parseGitFileStatus(value, `git.status.unstaged[${index}]`)),
    untracked: requireArray(record, 'untracked', 'git.status').map((value, index) => parseGitFileStatus(value, `git.status.untracked[${index}]`)),
  };
}

function parseGitDiffData(record: Record<string, unknown>): GitDiffData {
  return {
    diff: requireString(record, 'diff', 'git.diff'),
    filePath: requireString(record, 'filePath', 'git.diff'),
  };
}

function parseGitFileData(record: Record<string, unknown>): GitFileData {
  return {
    content: requireString(record, 'content', 'git.file'),
    filePath: requireString(record, 'filePath', 'git.file'),
  };
}

function parseWorktreeInfo(value: unknown, context: string): WorktreeInfo {
  const record = expectJsonRecord(value, context);
  return {
    path: requireString(record, 'path', context),
    branch: requireString(record, 'branch', context),
    headCommit: requireString(record, 'headCommit', context),
    isPrimary: requireBoolean(record, 'isPrimary', context),
    isDirty: requireBoolean(record, 'isDirty', context),
    dirtyFileCount: requireNumber(record, 'dirtyFileCount', context),
    ...(typeof record.isPrunable === 'boolean' ? { isPrunable: record.isPrunable } : {}),
  };
}

function parseWorktreeListResponse(record: Record<string, unknown>): WorktreeListResponse {
  return {
    worktrees: requireArray(record, 'worktrees', 'worktrees.list').map((value, index) =>
      parseWorktreeInfo(value, `worktrees.list.worktrees[${index}]`)
    ),
  };
}

function parseGitBranchListResponse(record: Record<string, unknown>): GitBranchListResponse {
  return {
    branches: requireArray(record, 'branches', 'git.branches').map((value, index) => {
      const branch = expectJsonRecord(value, `git.branches.branches[${index}]`);
      return { name: requireString(branch, 'name', `git.branches.branches[${index}]`) };
    }),
  };
}

function parseRemoveWorktreeResponse(record: Record<string, unknown>): RemoveWorktreeResponse {
  return {
    removed: requireString(record, 'removed', 'worktrees.remove'),
  };
}

export interface GitDiffData {
  diff: string;
  filePath: string;
}

export interface GitFileData {
  content: string;
  filePath: string;
}

/**
 * Fetch git status (staged, unstaged, untracked files) from the VM Agent.
 * Calls directly to ws-{id} subdomain, authenticated via workspace JWT token.
 */
export async function getGitStatus(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  worktree?: string
): Promise<GitStatusData> {
  const params = new URLSearchParams({ token });
  if (worktree) params.set('worktree', worktree);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/git/status?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Git status failed: ${text}`);
  }
  return readResponseJson(res, 'git.status', parseGitStatusData);
}

/**
 * Fetch unified diff for a single file from the VM Agent.
 */
export async function getGitDiff(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  filePath: string,
  staged = false,
  worktree?: string
): Promise<GitDiffData> {
  const params = new URLSearchParams({
    token,
    path: filePath,
    staged: String(staged),
  });
  if (worktree) params.set('worktree', worktree);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/git/diff?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Git diff failed: ${text}`);
  }
  return readResponseJson(res, 'git.diff', parseGitDiffData);
}

/**
 * Fetch full file content from the VM Agent.
 */
export async function getGitFile(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  filePath: string,
  ref?: string,
  worktree?: string
): Promise<GitFileData> {
  const params = new URLSearchParams({ token, path: filePath });
  if (ref) params.set('ref', ref);
  if (worktree) params.set('worktree', worktree);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/git/file?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Git file fetch failed: ${text}`);
  }
  return readResponseJson(res, 'git.file', parseGitFileData);
}

// ---------- File Browser (VM Agent direct) ----------

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  modifiedAt: string;
}

export interface FileListData {
  path: string;
  entries: FileEntry[];
}

function parseFileEntry(value: unknown, context: string): FileEntry {
  const record = expectJsonRecord(value, context);
  const type = requireString(record, 'type', context);
  if (type !== 'file' && type !== 'dir' && type !== 'symlink') {
    throw new Error(`Invalid file entry type at ${context}`);
  }
  return {
    name: requireString(record, 'name', context),
    type,
    size: requireNumber(record, 'size', context),
    modifiedAt: requireString(record, 'modifiedAt', context),
  };
}

function parseFileListData(record: Record<string, unknown>): FileListData {
  return {
    path: requireString(record, 'path', 'files.list'),
    entries: requireArray(record, 'entries', 'files.list').map((value, index) => parseFileEntry(value, `files.list.entries[${index}]`)),
  };
}

/**
 * Fetch directory listing from the VM Agent.
 */
export async function getFileList(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  path = '.',
  worktree?: string
): Promise<FileListData> {
  const params = new URLSearchParams({ token, path });
  if (worktree) params.set('worktree', worktree);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/list?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`File listing failed: ${text}`);
  }
  return readResponseJson(res, 'files.list', parseFileListData);
}

/**
 * Fetch a flat list of all file paths in the workspace (recursive find).
 * Used by the command palette for file search.
 */
export async function getFileIndex(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  worktree?: string
): Promise<string[]> {
  const params = new URLSearchParams({ token });
  if (worktree) params.set('worktree', worktree);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/find?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`File find failed: ${text}`);
  }
  const data = await readResponseJson(res, 'files.find', (record) => ({
    files: requireArray(record, 'files', 'files.find').filter((value): value is string => typeof value === 'string'),
  }));
  return data.files;
}

export async function getWorktrees(
  workspaceUrl: string,
  workspaceId: string,
  token: string
): Promise<WorktreeListResponse> {
  const params = new URLSearchParams({ token });
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/worktrees?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Worktree list failed: ${text}`);
  }
  return readResponseJson(res, 'worktrees.list', parseWorktreeListResponse);
}

export async function getGitBranches(
  workspaceUrl: string,
  workspaceId: string,
  token: string
): Promise<GitBranchListResponse> {
  const params = new URLSearchParams({ token });
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/git/branches?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Git branch list failed: ${text}`);
  }
  return readResponseJson(res, 'git.branches', parseGitBranchListResponse);
}

export async function createWorktree(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  worktreeRequest: CreateWorktreeRequest
): Promise<WorktreeInfo> {
  const params = new URLSearchParams({ token });
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/worktrees?${params.toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(worktreeRequest),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Worktree create failed: ${text}`);
  }
  return readResponseJson(res, 'worktrees.create', (record) =>
    parseWorktreeInfo(record, 'worktrees.create')
  );
}

export async function removeWorktree(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  path: string,
  force = false
): Promise<RemoveWorktreeResponse> {
  const params = new URLSearchParams({ token, path, force: String(force) });
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/worktrees?${params.toString()}`;
  const res = await fetch(url, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Worktree remove failed: ${text}`);
  }
  return readResponseJson(res, 'worktrees.remove', parseRemoveWorktreeResponse);
}

// ---------- Session File Proxy (proxied through CF Worker to VM agent) ----------

/** Fetch recursive file index via session proxy. Returns flat list of all file paths. */
export async function getSessionFileIndex(
  projectId: string,
  sessionId: string
): Promise<string[]> {
  const data = await request<{ files: string[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/files/find`
  );
  return data.files;
}

/** Fetch directory listing via session proxy. */
export async function getSessionFileList(
  projectId: string,
  sessionId: string,
  path = '.'
): Promise<FileListData> {
  const params = new URLSearchParams({ path });
  return request<FileListData>(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/files/list?${params.toString()}`
  );
}

/** Fetch file content via session proxy. */
export async function getSessionFileContent(
  projectId: string,
  sessionId: string,
  filePath: string
): Promise<GitFileData> {
  const params = new URLSearchParams({ path: filePath });
  return request<GitFileData>(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/files/view?${params.toString()}`
  );
}

/**
 * Build a URL to fetch raw binary file content via session proxy.
 * Used as <img src> for image rendering — browser handles the fetch directly.
 * Must be an absolute URL (including API_URL) because the web app and API are
 * on different subdomains (app.* vs api.*). A relative `/api/...` path would
 * resolve against the app origin and 404.
 */
export function getSessionFileRawUrl(
  projectId: string,
  sessionId: string,
  filePath: string
): string {
  const params = new URLSearchParams({ path: filePath });
  return `${API_URL}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/files/raw?${params.toString()}`;
}

/**
 * Build a URL to fetch raw binary file content directly from workspace VM agent.
 * Used as <img src> for image rendering in workspace views.
 */
export function getFileRawUrl(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  filePath: string,
  worktree?: string
): string {
  const params = new URLSearchParams({ token, path: filePath });
  if (worktree) params.set('worktree', worktree);
  return `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/raw?${params.toString()}`;
}

/** Fetch git status via session proxy. */
export async function getSessionGitStatus(
  projectId: string,
  sessionId: string
): Promise<GitStatusData> {
  return request<GitStatusData>(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/git/status`
  );
}

/** Fetch git diff for a file via session proxy. */
export async function getSessionGitDiff(
  projectId: string,
  sessionId: string,
  filePath: string,
  staged = false
): Promise<GitDiffData> {
  const params = new URLSearchParams({ path: filePath, staged: String(staged) });
  return request<GitDiffData>(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/git/diff?${params.toString()}`
  );
}

// ---------- File Upload/Download (proxied through CF Worker to VM agent) ----------

export interface FileUploadResponse {
  files: Array<{ name: string; path: string; size: number }>;
}

/** Upload files to a workspace via session proxy. */
export async function uploadSessionFiles(
  projectId: string,
  sessionId: string,
  files: File[],
  destination?: string
): Promise<FileUploadResponse> {
  const formData = new FormData();
  if (destination) formData.append('destination', destination);
  for (const file of files) {
    formData.append('files', file);
  }
  const response = await fetch(
    `${API_URL}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/files/upload`,
    {
      method: 'POST',
      credentials: 'include',
      body: formData,
      // Do NOT set Content-Type — browser sets it with boundary automatically
    }
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: 'UNKNOWN_ERROR', message: 'Upload failed' }));
    throw new ApiClientError((data as ApiError).error, (data as ApiError).message, response.status);
  }
  return readResponseJson(response, 'files.upload', (record) => ({
    files: requireArray(record, 'files', 'files.upload').map((value, index) => {
      const file = expectJsonRecord(value, `files.upload.files[${index}]`);
      return {
        name: requireString(file, 'name', `files.upload.files[${index}]`),
        path: requireString(file, 'path', `files.upload.files[${index}]`),
        size: requireNumber(file, 'size', `files.upload.files[${index}]`),
      };
    }),
  }));
}

/** Download a file from a workspace via session proxy. Returns a blob URL. */
export async function downloadSessionFile(
  projectId: string,
  sessionId: string,
  filePath: string
): Promise<{ blob: Blob; fileName: string }> {
  const params = new URLSearchParams({ path: filePath });
  const response = await fetch(
    `${API_URL}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/files/download?${params.toString()}`,
    { credentials: 'include' }
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: 'UNKNOWN_ERROR', message: 'Download failed' }));
    throw new ApiClientError((data as ApiError).error, (data as ApiError).message, response.status);
  }
  const blob = await response.blob();
  // Extract filename from Content-Disposition or fall back to path basename
  const cd = response.headers.get('Content-Disposition') ?? '';
  const match = cd.match(/filename="?([^";\n]+)"?/);
  const fileName = match?.[1] ?? filePath.split('/').pop() ?? 'download';
  return { blob, fileName };
}
