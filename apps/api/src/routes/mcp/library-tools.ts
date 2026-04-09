/**
 * MCP library tools — browse, download, upload, and replace project file library files.
 *
 * These tools allow agents to interact with encrypted per-project file storage.
 * Downloads fetch decrypted content from R2 and push it to the workspace via VM agent.
 * Uploads fetch file content from the workspace via VM agent and encrypt+store in R2.
 */
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../index';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import {
  downloadFile,
  getFile,
  listFiles,
  replaceFile,
  updateTags,
  uploadFile,
} from '../../services/file-library';
import { signTerminalToken } from '../../services/jwt';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

type AppDb = DrizzleD1Database<typeof schema>;

// ─── Configurable defaults (Constitution Principle XI) ──────────────────────

/** Default directory in workspace for downloaded library files. Override via LIBRARY_MCP_DOWNLOAD_DIR. */
const DEFAULT_LIBRARY_MCP_DOWNLOAD_DIR = '.library';
function getDownloadDir(env: Env): string {
  return env.LIBRARY_MCP_DOWNLOAD_DIR ?? DEFAULT_LIBRARY_MCP_DOWNLOAD_DIR;
}

/** Timeout for VM agent file transfer calls. Override via LIBRARY_MCP_TRANSFER_TIMEOUT_MS. */
const DEFAULT_LIBRARY_MCP_TRANSFER_TIMEOUT_MS = 60_000;
function getTransferTimeout(env: Env): number {
  return parsePositiveInt(env.LIBRARY_MCP_TRANSFER_TIMEOUT_MS, DEFAULT_LIBRARY_MCP_TRANSFER_TIMEOUT_MS);
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function getEncryptionKey(env: Env): string {
  const key = env.LIBRARY_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('Encryption key not configured');
  }
  return key;
}

/**
 * Validate that a path is relative and does not contain traversal segments.
 * Returns null if valid, or an error message if invalid.
 */
function validateRelativePath(path: string): string | null {
  if (path.startsWith('/')) {
    return 'Path must be relative (cannot start with /)';
  }
  if (path.split('/').includes('..')) {
    return 'Path cannot contain ".." segments';
  }
  return null;
}

function requireWorkspaceId(
  requestId: string | number | null,
  tokenData: McpTokenData,
): JsonRpcResponse | null {
  if (!tokenData.workspaceId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No active workspace — this tool requires a workspace context');
  }
  return null;
}

/**
 * Resolve the workspace's node ID and build the VM agent base URL.
 * Returns null and a JSON-RPC error if the workspace is not found or not running.
 */
async function resolveWorkspaceVmUrl(
  db: AppDb,
  env: Env,
  workspaceId: string,
  projectId: string,
): Promise<{ vmBaseUrl: string; nodeId: string } | { error: string }> {
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      status: schema.workspaces.status,
      nodeId: schema.workspaces.nodeId,
    })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.id, workspaceId),
        eq(schema.workspaces.projectId, projectId),
      ),
    )
    .limit(1);

  if (!workspace) {
    return { error: 'Workspace not found' };
  }
  if (workspace.status !== 'running' && workspace.status !== 'recovery') {
    return { error: `Workspace is not running (status: ${workspace.status})` };
  }
  if (!workspace.nodeId) {
    return { error: 'Workspace has no assigned node' };
  }

  const nodeIdLower = workspace.nodeId.toLowerCase();
  if (!/^[a-z0-9-]+$/.test(nodeIdLower)) {
    return { error: 'Invalid node ID format' };
  }

  const protocol = env.VM_AGENT_PROTOCOL || 'https';
  const port = env.VM_AGENT_PORT || '8443';
  const vmBaseUrl = `${protocol}://${nodeIdLower}.vm.${env.BASE_DOMAIN}:${port}`;
  return { vmBaseUrl, nodeId: workspace.nodeId };
}

/**
 * Upload a file to the workspace via VM agent multipart upload.
 */
async function uploadToWorkspace(
  env: Env,
  vmBaseUrl: string,
  workspaceId: string,
  userId: string,
  filename: string,
  data: ArrayBuffer,
  targetPath: string,
): Promise<void> {
  const { token } = await signTerminalToken(userId, workspaceId, env);
  const url = `${vmBaseUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/upload`;

  const formData = new FormData();
  formData.append('destination', targetPath);
  formData.append('files', new Blob([data]), filename);

  // Use Authorization header for server-to-server calls (not query param)
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
    signal: AbortSignal.timeout(getTransferTimeout(env)),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown');
    throw new Error(`VM agent upload failed: ${res.status} ${text}`);
  }
}

/**
 * Download a file from the workspace via VM agent.
 * Returns the file data as ArrayBuffer and the content type.
 */
async function downloadFromWorkspace(
  env: Env,
  vmBaseUrl: string,
  workspaceId: string,
  userId: string,
  filePath: string,
): Promise<{ data: ArrayBuffer; contentType: string }> {
  const { token } = await signTerminalToken(userId, workspaceId, env);
  const params = new URLSearchParams({ path: filePath });
  const url = `${vmBaseUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/download?${params.toString()}`;

  // Use Authorization header for server-to-server calls (not query param)
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(getTransferTimeout(env)),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown');
    if (res.status === 404) {
      throw new Error(`File not found in workspace: ${filePath}`);
    }
    throw new Error(`VM agent download failed: ${res.status} ${text}`);
  }

  // Guard against oversized responses to avoid OOM in Workers (128 MB heap)
  const contentLength = parseInt(res.headers.get('Content-Length') ?? '0', 10);
  const DEFAULT_LIBRARY_UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
  const maxBytes = parsePositiveInt(env.LIBRARY_UPLOAD_MAX_BYTES, DEFAULT_LIBRARY_UPLOAD_MAX_BYTES);
  if (contentLength > maxBytes) {
    throw new Error(`File too large: ${contentLength} bytes exceeds maximum ${maxBytes}`);
  }

  const data = await res.arrayBuffer();
  const contentType = res.headers.get('Content-Type') || 'application/octet-stream';
  return { data, contentType };
}

// ─── Tool handlers ──────────────────────────────────────────────────────────

/**
 * list_library_files — browse project file library with filters.
 */
export async function handleListLibraryFiles(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  try {
    const db = drizzle(env.DATABASE, { schema });

    // Parse optional filters (bound arrays to prevent unbounded iteration)
    const DEFAULT_MAX_TAGS_INPUT = 50;
    const tags = Array.isArray(params.tags)
      ? params.tags.filter((t): t is string => typeof t === 'string').slice(0, DEFAULT_MAX_TAGS_INPUT)
      : undefined;
    const fileType = typeof params.fileType === 'string' ? params.fileType : undefined;
    const source = params.source === 'user' || params.source === 'agent' ? params.source : undefined;
    const VALID_SORT_FIELDS = ['createdAt', 'filename', 'sizeBytes'] as const;
    const sortBy = typeof params.sortBy === 'string' && (VALID_SORT_FIELDS as readonly string[]).includes(params.sortBy)
      ? (params.sortBy as typeof VALID_SORT_FIELDS[number])
      : undefined;
    const limit = typeof params.limit === 'number' && params.limit > 0
      ? Math.min(Math.floor(params.limit), 200)
      : undefined;

    const result = await listFiles(db, env, tokenData.projectId, {
      tags,
      mimeType: fileType,
      uploadSource: source,
      sortBy: sortBy ?? 'createdAt',
      sortOrder: 'desc',
      limit,
    });

    const files = result.files.map((f) => ({
      id: f.id,
      filename: f.filename,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      tags: f.tags.map((t) => t.tag),
      description: f.description,
      uploadSource: f.uploadSource,
      createdAt: f.createdAt,
    }));

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({ files, totalCount: result.total }, null, 2) }],
    });
  } catch (err) {
    log.error('mcp.list_library_files.error', { projectId: tokenData.projectId, error: String(err) });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to list library files');
  }
}

/**
 * download_library_file — decrypt file from R2 and transfer to workspace.
 */
export async function handleDownloadLibraryFile(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  // Require workspace
  const wsErr = requireWorkspaceId(requestId, tokenData);
  if (wsErr) return wsErr;

  const fileId = params.fileId;
  if (typeof fileId !== 'string' || !fileId.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'fileId is required and must be a non-empty string');
  }

  try {
    const db = drizzle(env.DATABASE, { schema });
    const encryptionKey = getEncryptionKey(env);

    // Check workspace is reachable first (cheap D1 query) before expensive R2 decrypt
    const vmResult = await resolveWorkspaceVmUrl(db, env, tokenData.workspaceId, tokenData.projectId);
    if ('error' in vmResult) {
      return jsonRpcError(requestId, INTERNAL_ERROR, vmResult.error);
    }

    // Download and decrypt from R2
    const { data, file } = await downloadFile(db, env.R2, encryptionKey, tokenData.projectId, fileId);

    // Determine and validate target path
    const targetDir = typeof params.targetPath === 'string' && params.targetPath.trim()
      ? params.targetPath.trim()
      : getDownloadDir(env);

    const pathErr = validateRelativePath(targetDir);
    if (pathErr) {
      return jsonRpcError(requestId, INVALID_PARAMS, pathErr);
    }

    // Upload to workspace
    await uploadToWorkspace(
      env,
      vmResult.vmBaseUrl,
      tokenData.workspaceId,
      tokenData.userId,
      file.filename,
      data,
      targetDir,
    );

    const downloadedTo = `${targetDir}/${file.filename}`;

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({
        downloadedTo,
        filename: file.filename,
        sizeBytes: file.sizeBytes,
      }, null, 2) }],
    });
  } catch (err) {
    log.error('mcp.download_library_file.error', {
      projectId: tokenData.projectId,
      fileId,
      error: String(err),
    });
    const message = (err as Error).message;
    if (message.includes('not found') || message.includes('Not Found')) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'File not found in library');
    }
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to download library file');
  }
}

/**
 * upload_to_library — read file from workspace, encrypt, and store in library.
 * Returns FILE_EXISTS error with existing file metadata if filename already exists.
 */
export async function handleUploadToLibrary(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  // Require workspace
  const wsErr = requireWorkspaceId(requestId, tokenData);
  if (wsErr) return wsErr;

  const filePath = params.filePath;
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'filePath is required and must be a non-empty string');
  }

  const description = typeof params.description === 'string' ? params.description : undefined;
  const tags = Array.isArray(params.tags) ? params.tags.filter((t): t is string => typeof t === 'string').slice(0, 50) : undefined;

  try {
    const db = drizzle(env.DATABASE, { schema });
    const encryptionKey = getEncryptionKey(env);

    // Resolve workspace VM URL
    const vmResult = await resolveWorkspaceVmUrl(db, env, tokenData.workspaceId, tokenData.projectId);
    if ('error' in vmResult) {
      return jsonRpcError(requestId, INTERNAL_ERROR, vmResult.error);
    }

    // Download file from workspace
    const { data, contentType } = await downloadFromWorkspace(
      env,
      vmResult.vmBaseUrl,
      tokenData.workspaceId,
      tokenData.userId,
      filePath.trim(),
    );

    // Extract filename from path
    const filename = filePath.trim().split('/').pop() || 'unknown';

    const mimeType = contentType;

    // Upload to library (will throw 409 on duplicate filename)
    const result = await uploadFile(db, env.R2, encryptionKey, env, tokenData.projectId, tokenData.userId, filename, mimeType, data, {
      description,
      tags,
      uploadSource: 'agent',
      uploadSessionId: tokenData.taskId, // task context doubles as session context for agents
      uploadTaskId: tokenData.taskId,
      tagSource: 'agent',
    });

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({
        fileId: result.id,
        filename: result.filename,
        sizeBytes: result.sizeBytes,
      }, null, 2) }],
    });
  } catch (err) {
    const message = (err as Error).message;

    // Handle duplicate filename — return structured FILE_EXISTS error
    if (message.includes('already exists')) {
      try {
        const lookupDb = drizzle(env.DATABASE, { schema });
        const filename = filePath.trim().split('/').pop() || 'unknown';

        // Look up existing file to return metadata
        const [existing] = await lookupDb
          .select()
          .from(schema.projectFiles)
          .where(
            and(
              eq(schema.projectFiles.projectId, tokenData.projectId),
              eq(schema.projectFiles.filename, filename),
            ),
          )
          .limit(1);

        if (existing) {
          return jsonRpcSuccess(requestId, {
            content: [{ type: 'text', text: JSON.stringify({
              error: 'FILE_EXISTS',
              existingFile: {
                id: existing.id,
                filename: existing.filename,
                sizeBytes: existing.sizeBytes,
                uploadSource: existing.uploadSource,
                uploadedBy: existing.uploadedBy,
                createdAt: existing.createdAt,
              },
            }, null, 2) }],
          });
        }
      } catch (lookupErr) {
        log.error('mcp.upload_to_library.exists_lookup_failed', {
          projectId: tokenData.projectId,
          filename: filePath.trim().split('/').pop(),
          error: String(lookupErr),
        });
        // Fall through to generic error if lookup fails
      }
      return jsonRpcError(requestId, INVALID_PARAMS, message);
    }

    log.error('mcp.upload_to_library.error', {
      projectId: tokenData.projectId,
      filePath,
      error: String(err),
    });

    if (message.includes('not found') || message.includes('Not Found')) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'File not found in workspace');
    }
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to upload to library');
  }
}

/**
 * replace_library_file — download new content from workspace and replace existing library file.
 * New tags are merged with existing tags.
 */
export async function handleReplaceLibraryFile(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  // Require workspace
  const wsErr = requireWorkspaceId(requestId, tokenData);
  if (wsErr) return wsErr;

  const fileId = params.fileId;
  if (typeof fileId !== 'string' || !fileId.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'fileId is required and must be a non-empty string');
  }

  const filePath = params.filePath;
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'filePath is required and must be a non-empty string');
  }

  const description = typeof params.description === 'string' ? params.description : undefined;
  const tags = Array.isArray(params.tags) ? params.tags.filter((t): t is string => typeof t === 'string').slice(0, 50) : undefined;

  try {
    const db = drizzle(env.DATABASE, { schema });
    const encryptionKey = getEncryptionKey(env);

    // Verify file exists first to return clean error
    let existingFile;
    try {
      existingFile = await getFile(db, tokenData.projectId, fileId);
    } catch {
      return jsonRpcSuccess(requestId, {
        content: [{ type: 'text', text: JSON.stringify({ error: 'FILE_NOT_FOUND' }, null, 2) }],
      });
    }

    const previousSizeBytes = existingFile.file.sizeBytes;

    // Resolve workspace VM URL
    const vmResult = await resolveWorkspaceVmUrl(db, env, tokenData.workspaceId, tokenData.projectId);
    if ('error' in vmResult) {
      return jsonRpcError(requestId, INTERNAL_ERROR, vmResult.error);
    }

    // Download new file from workspace
    const { data, contentType } = await downloadFromWorkspace(
      env,
      vmResult.vmBaseUrl,
      tokenData.workspaceId,
      tokenData.userId,
      filePath.trim(),
    );

    // Extract filename from path
    const filename = filePath.trim().split('/').pop() || existingFile.file.filename;
    const mimeType = contentType;

    // Replace file in library
    const updated = await replaceFile(
      db,
      env.R2,
      encryptionKey,
      env,
      tokenData.projectId,
      fileId,
      tokenData.userId,
      filename,
      mimeType,
      data,
      { description },
    );

    // Merge new tags with existing (additive)
    if (tags && tags.length > 0) {
      await updateTags(db, env, tokenData.projectId, fileId, { add: tags }, 'agent');
    }

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({
        fileId: updated.id,
        filename: updated.filename,
        sizeBytes: updated.sizeBytes,
        previousSizeBytes,
      }, null, 2) }],
    });
  } catch (err) {
    log.error('mcp.replace_library_file.error', {
      projectId: tokenData.projectId,
      fileId,
      filePath,
      error: String(err),
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to replace library file');
  }
}
