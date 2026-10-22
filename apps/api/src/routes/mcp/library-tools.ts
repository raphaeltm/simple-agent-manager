/**
 * MCP library tools — browse, download, upload, and replace project file library files.
 *
 * These tools allow agents to interact with encrypted per-project file storage.
 * Downloads fetch decrypted content from R2 and push it to the workspace via VM agent.
 * Uploads fetch file content from the workspace via VM agent and encrypt+store in R2.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import {
  downloadFile,
  getFile,
  getListMaxPageSize,
  getMaxTagsPerFile,
  listFiles,
  uploadFile,
  validateDirectory,
} from '../../services/file-library';
import {
  downloadFromWorkspace,
  resolveWorkspaceVmUrl,
  uploadToWorkspace,
  validateRelativePath,
} from '../../services/workspace-file-transfer';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';
import { getEncryptionKey, requireWorkspaceId } from './library-tool-helpers';

export { handleReplaceLibraryFile } from './library-replace-tool';

// ─── Configurable defaults (Constitution Principle XI) ──────────────────────

/** Default directory in workspace for downloaded library files. Override via LIBRARY_MCP_DOWNLOAD_DIR. */
const DEFAULT_LIBRARY_MCP_DOWNLOAD_DIR = '.library';
function getDownloadDir(env: Env): string {
  return env.LIBRARY_MCP_DOWNLOAD_DIR ?? DEFAULT_LIBRARY_MCP_DOWNLOAD_DIR;
}

/** Max caption length for display_from_library cards. Override via LIBRARY_MCP_CAPTION_MAX_LENGTH. */
const DEFAULT_LIBRARY_MCP_CAPTION_MAX = 500;
/** Floor to keep a misconfigured (tiny) cap from silently breaking captions. */
const MIN_LIBRARY_MCP_CAPTION_MAX = 20;
function getCaptionMax(env: Env): number {
  return Math.max(
    parsePositiveInt(env.LIBRARY_MCP_CAPTION_MAX_LENGTH, DEFAULT_LIBRARY_MCP_CAPTION_MAX),
    MIN_LIBRARY_MCP_CAPTION_MAX
  );
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

// ─── Tool handlers ──────────────────────────────────────────────────────────

/**
 * list_library_files — browse project file library with filters.
 */
export async function handleListLibraryFiles(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  try {
    const db = drizzle(env.DATABASE, { schema });

    // Parse optional filters (bound arrays to prevent unbounded iteration)
    const maxTags = getMaxTagsPerFile(env);
    const tags = Array.isArray(params.tags)
      ? params.tags.filter((t): t is string => typeof t === 'string').slice(0, maxTags)
      : undefined;
    const fileType = typeof params.fileType === 'string' ? params.fileType : undefined;
    const source =
      params.source === 'user' || params.source === 'agent' ? params.source : undefined;
    const VALID_SORT_FIELDS = ['createdAt', 'filename', 'sizeBytes'] as const;
    const sortBy =
      typeof params.sortBy === 'string' &&
      (VALID_SORT_FIELDS as readonly string[]).includes(params.sortBy)
        ? (params.sortBy as (typeof VALID_SORT_FIELDS)[number])
        : undefined;
    const maxPageSize = getListMaxPageSize(env);
    const limit =
      typeof params.limit === 'number' && params.limit > 0
        ? Math.min(Math.floor(params.limit), maxPageSize)
        : undefined;
    const rawDirectory = typeof params.directory === 'string' ? params.directory : undefined;
    let directory: string | undefined;
    if (rawDirectory) {
      try {
        directory = validateDirectory(rawDirectory, env);
      } catch {
        return jsonRpcError(requestId, INVALID_PARAMS, 'Invalid directory path');
      }
    }
    const recursive = typeof params.recursive === 'boolean' ? params.recursive : undefined;

    const result = await listFiles(db, env, tokenData.projectId, {
      tags,
      mimeType: fileType,
      uploadSource: source,
      directory,
      recursive,
      sortBy: sortBy ?? 'createdAt',
      sortOrder: 'desc',
      limit,
    });

    const files = result.files.map((f) => ({
      id: f.id,
      filename: f.filename,
      directory: f.directory,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      tags: f.tags.map((t) => t.tag),
      description: f.description,
      uploadSource: f.uploadSource,
      createdAt: f.createdAt,
    }));

    return jsonRpcSuccess(requestId, {
      content: [
        { type: 'text', text: JSON.stringify({ files, totalCount: result.total }, null, 2) },
      ],
    });
  } catch (err) {
    log.error('mcp.list_library_files.error', {
      projectId: tokenData.projectId,
      error: String(err),
    });
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
  env: Env
): Promise<JsonRpcResponse> {
  // Require workspace
  const wsErr = requireWorkspaceId(requestId, tokenData);
  if (wsErr) return wsErr;

  const fileId = params.fileId;
  if (typeof fileId !== 'string' || !fileId.trim()) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'fileId is required and must be a non-empty string'
    );
  }

  try {
    const db = drizzle(env.DATABASE, { schema });
    const encryptionKey = getEncryptionKey(env);

    // Check workspace is reachable first (cheap D1 query) before expensive R2 decrypt
    const vmResult = await resolveWorkspaceVmUrl(
      db,
      env,
      tokenData.workspaceId,
      tokenData.projectId
    );
    if ('error' in vmResult) {
      return jsonRpcError(requestId, INTERNAL_ERROR, vmResult.error);
    }

    // Download and decrypt from R2
    const { data, file } = await downloadFile(
      db,
      env.R2,
      encryptionKey,
      tokenData.projectId,
      fileId
    );

    // Determine and validate target path
    const targetDir =
      typeof params.targetPath === 'string' && params.targetPath.trim()
        ? params.targetPath.trim()
        : getDownloadDir(env);

    const pathErr = validateRelativePath(targetDir);
    if (pathErr) {
      return jsonRpcError(requestId, INVALID_PARAMS, pathErr);
    }

    // Upload to workspace
    await uploadToWorkspace({
      env,
      vmBaseUrl: vmResult.vmBaseUrl,
      nodeId: vmResult.nodeId,
      workspaceId: tokenData.workspaceId,
      userId: tokenData.userId,
      filename: file.filename,
      data,
      targetPath: targetDir,
    });

    const downloadedTo = `${targetDir}/${file.filename}`;

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              downloadedTo,
              filename: file.filename,
              sizeBytes: file.sizeBytes,
            },
            null,
            2
          ),
        },
      ],
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
  env: Env
): Promise<JsonRpcResponse> {
  // Require workspace
  const wsErr = requireWorkspaceId(requestId, tokenData);
  if (wsErr) return wsErr;

  const filePath = params.filePath;
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'filePath is required and must be a non-empty string'
    );
  }

  const description = typeof params.description === 'string' ? params.description : undefined;
  const tags = Array.isArray(params.tags)
    ? params.tags.filter((t): t is string => typeof t === 'string').slice(0, getMaxTagsPerFile(env))
    : undefined;
  const directory = typeof params.directory === 'string' ? params.directory : undefined;

  try {
    const db = drizzle(env.DATABASE, { schema });
    const encryptionKey = getEncryptionKey(env);

    // Resolve workspace VM URL
    const vmResult = await resolveWorkspaceVmUrl(
      db,
      env,
      tokenData.workspaceId,
      tokenData.projectId
    );
    if ('error' in vmResult) {
      return jsonRpcError(requestId, INTERNAL_ERROR, vmResult.error);
    }

    // Download file from workspace
    const { data, contentType } = await downloadFromWorkspace(
      env,
      vmResult.vmBaseUrl,
      vmResult.nodeId,
      tokenData.workspaceId,
      tokenData.userId,
      filePath.trim()
    );

    // Extract filename from path
    const filename = filePath.trim().split('/').pop() || 'unknown';

    const mimeType = contentType;

    // Upload to library (will throw 409 on duplicate filename in same directory)
    const result = await uploadFile(
      db,
      env.R2,
      encryptionKey,
      env,
      tokenData.projectId,
      tokenData.userId,
      filename,
      mimeType,
      data,
      {
        description,
        tags,
        uploadSource: 'agent',
        uploadSessionId: tokenData.taskId, // task context doubles as session context for agents
        uploadTaskId: tokenData.taskId,
        tagSource: 'agent',
        directory,
      }
    );

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              fileId: result.id,
              filename: result.filename,
              mimeType: result.mimeType,
              sizeBytes: result.sizeBytes,
            },
            null,
            2
          ),
        },
      ],
    });
  } catch (err) {
    const message = (err as Error).message;

    // Handle duplicate filename — return structured FILE_EXISTS error
    if (message.includes('already exists')) {
      try {
        const lookupDb = drizzle(env.DATABASE, { schema });
        const filename = filePath.trim().split('/').pop() || 'unknown';
        const lookupDir = directory ?? '/';

        // Look up existing file to return metadata (scoped to directory)
        const [existing] = await lookupDb
          .select()
          .from(schema.projectFiles)
          .where(
            and(
              eq(schema.projectFiles.projectId, tokenData.projectId),
              eq(schema.projectFiles.directory, lookupDir),
              eq(schema.projectFiles.filename, filename)
            )
          )
          .limit(1);

        if (existing) {
          return jsonRpcSuccess(requestId, {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    error: 'FILE_EXISTS',
                    existingFile: {
                      id: existing.id,
                      filename: existing.filename,
                      mimeType: existing.mimeType,
                      sizeBytes: existing.sizeBytes,
                      uploadSource: existing.uploadSource,
                      uploadedBy: existing.uploadedBy,
                      createdAt: existing.createdAt,
                    },
                  },
                  null,
                  2
                ),
              },
            ],
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
    // Pass through validation errors (file limit, size limit, bad filename, etc.)
    if (
      err instanceof Error &&
      'statusCode' in err &&
      (err as { statusCode: number }).statusCode === 400
    ) {
      return jsonRpcError(requestId, INVALID_PARAMS, message);
    }
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to upload to library');
  }
}

/**
 * display_from_library — surface an existing library file as a document card in
 * the chat. Worker-side only (no workspace required): validates the fileId
 * belongs to the caller's project and returns the metadata the DocumentCard
 * needs to render (fileId, filename, mimeType, sizeBytes) plus an optional
 * caption. The card and its durability come from the persisted tool message —
 * this handler's value is the UI side effect, not the returned payload.
 */
export async function handleDisplayFromLibrary(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const fileId = params.fileId;
  if (typeof fileId !== 'string' || !fileId.trim()) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'fileId is required and must be a non-empty string'
    );
  }

  // Optional caption — bound length to keep tool metadata lean and avoid an
  // unbounded string rendering in the card.
  const captionMax = getCaptionMax(env);
  const caption =
    typeof params.caption === 'string' && params.caption.trim()
      ? params.caption.trim().slice(0, captionMax)
      : undefined;

  try {
    const db = drizzle(env.DATABASE, { schema });

    // Project-scoped ownership check: getFile filters by projectId and throws
    // notFound when the row is missing or belongs to another project. This is
    // the trust boundary — a cross-project fileId must never resolve.
    let existing;
    try {
      existing = await getFile(db, tokenData.projectId, fileId.trim());
    } catch {
      return jsonRpcSuccess(requestId, {
        content: [{ type: 'text', text: JSON.stringify({ error: 'FILE_NOT_FOUND' }, null, 2) }],
      });
    }

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              fileId: existing.file.id,
              filename: existing.file.filename,
              mimeType: existing.file.mimeType,
              sizeBytes: existing.file.sizeBytes,
              ...(caption ? { caption } : {}),
            },
            null,
            2
          ),
        },
      ],
    });
  } catch (err) {
    log.error('mcp.display_from_library.error', {
      projectId: tokenData.projectId,
      fileId,
      error: String(err),
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to display library file');
  }
}
