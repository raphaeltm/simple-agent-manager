/**
 * MCP tool `replace_library_file`: replace a library file's content with a workspace file.
 * Split from `library-tools.ts` (rule 18); `library-tools.ts` re-exports the handler.
 */
import { AppError } from '@simple-agent-manager/worker-core';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { releaseArrayBuffer } from '../../lib/release-array-buffer';
import { getFile, getMaxTagsPerFile, replaceFile, updateTags } from '../../services/file-library';
import { withLibraryMemory } from '../../services/library-memory';
import {
  downloadFromWorkspace,
  resolveWorkspaceVmUrl,
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

/**
 * replace_library_file — download new content from workspace and replace existing library file.
 * New tags are merged with existing tags.
 */
export async function handleReplaceLibraryFile(
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
    const vmResult = await resolveWorkspaceVmUrl(
      db,
      env,
      tokenData.workspaceId,
      tokenData.projectId
    );
    if ('error' in vmResult) {
      return jsonRpcError(requestId, INTERNAL_ERROR, vmResult.error);
    }

    const updated = await withLibraryMemory(async () => {
      // Download new file from workspace
      const { data, contentType } = await downloadFromWorkspace(
        env,
        vmResult.vmBaseUrl,
        vmResult.nodeId,
        tokenData.workspaceId,
        tokenData.userId,
        filePath.trim()
      );
      try {
        // Extract filename from path
        const filename = filePath.trim().split('/').pop() || existingFile.file.filename;
        const mimeType = contentType;

        // Replace file in library
        return await replaceFile(
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
          { description }
        );
      } finally {
        releaseArrayBuffer(data);
      }
    });

    // Merge new tags with existing (additive)
    if (tags && tags.length > 0) {
      await updateTags(db, env, tokenData.projectId, fileId, { add: tags }, 'agent');
    }

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              fileId: updated.id,
              filename: updated.filename,
              mimeType: updated.mimeType,
              sizeBytes: updated.sizeBytes,
              previousSizeBytes,
            },
            null,
            2
          ),
        },
      ],
    });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 429) {
      return jsonRpcError(requestId, INTERNAL_ERROR, err.message, {
        httpStatus: 429,
        retryable: true,
      });
    }
    log.error('mcp.replace_library_file.error', {
      projectId: tokenData.projectId,
      fileId,
      filePath,
      error: String(err),
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to replace library file');
  }
}
