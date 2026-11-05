/**
 * MCP tool: display_from_library (split from library-tools.ts).
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { getFile } from '../../services/file-library';
import { mcpDebugPackageFileAccess } from '../../services/fleet-ops/debug-package-access';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

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
      if ((await mcpDebugPackageFileAccess(env, tokenData, existing.file.directory)) === 'denied') {
        throw new Error('debug package hidden');
      }
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
