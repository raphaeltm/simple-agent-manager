/**
 * Project File Library API routes.
 *
 * All routes are scoped to a project and require authentication + project membership.
 * Mounted at /api/projects/:projectId/library
 */

import type { ListFilesRequest } from '@simple-agent-manager/shared';
import { LIBRARY_DEFAULTS, resolveEffectiveMimeType } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireTrustedWriteOrigin } from '../lib/browser-write-origin';
import { getAuth, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectAccess, requireProjectCapability } from '../middleware/project-auth';
import { jsonValidator, MoveFileSchema, UpdateTagsSchema } from '../schemas';
import {
  deleteFile,
  downloadFile,
  getDownloadTimeoutMs,
  getFile,
  listDirectories,
  listFiles,
  moveFile,
  replaceFile,
  updateTags,
  uploadFile,
  validateDirectory,
  validateFilename,
} from '../services/file-library';
import {
  contentDispositionFilename,
  downloadContentType,
  hasPreviewableContent,
  isInlinePreviewable,
  parseByteRange,
  previewHeaders,
} from '../services/file-serving-policy';
import {
  assertDebugPackageVisibleTo,
  debugPackageListOptions,
  isDebugPackageDirectory,
  userMayReadDebugPackages,
} from '../services/fleet-ops/debug-package-access';
import {
  getPreviewHostname,
  getPreviewUrlTtlSeconds,
  mintPreviewPath,
} from '../services/interactive-preview';
import { loadLibraryDownload } from '../services/library-memory';
import { getEncryptionKey, requireParam, validateSearchLength } from './library-route-helpers';
import { withLibraryUpload } from './library-upload-request';

const libraryRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST /upload — multipart file upload
// ---------------------------------------------------------------------------

// Multipart is a CORS-simple request, so a same-site workspace page could post it with the
// session cookie and no preflight. See lib/browser-write-origin.ts.
const uploadOrigin = requireTrustedWriteOrigin('library upload');

libraryRoutes.post('/upload', requireAuth(), requireApproved(), uploadOrigin, async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'project:update');

  return withLibraryUpload(c.req.raw, c.env, async (upload) => {
    const { filename, mimeType, description, directory, data } = upload;
    validateFilename(filename, c.env);
    const tags = upload.tags
      ?.split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const encryptionKey = getEncryptionKey(c.env);

    const result = await uploadFile(
      db,
      c.env.R2,
      encryptionKey,
      c.env,
      projectId,
      userId,
      filename,
      mimeType,
      data,
      {
        description,
        tags,
        // A browser upload has user provenance. Agent/task identities must come from
        // authenticated server context, never from multipart fields supplied by a client.
        uploadSource: 'user',
        directory,
      }
    );

    return c.json(result, 201);
  });
});

// ---------------------------------------------------------------------------
// PUT /:fileId/replace — replace file content
// ---------------------------------------------------------------------------

libraryRoutes.put('/:fileId/replace', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const fileId = requireParam(c.req.param('fileId'), 'fileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'project:update');

  return withLibraryUpload(c.req.raw, c.env, async ({ filename, mimeType, description, data }) => {
    validateFilename(filename, c.env);
    const encryptionKey = getEncryptionKey(c.env);

    const result = await replaceFile(
      db,
      c.env.R2,
      encryptionKey,
      c.env,
      projectId,
      fileId,
      userId,
      filename,
      mimeType,
      data,
      { description }
    );

    return c.json(result, 200);
  });
});

// ---------------------------------------------------------------------------
// GET / — list files with filters
// ---------------------------------------------------------------------------

libraryRoutes.get('/', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectAccess(db, projectId, userId);

  const query = c.req.query();
  validateSearchLength(query['search'] || undefined, c.env);
  const filters: ListFilesRequest = {
    tags: query['tags']
      ? query['tags']
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined,
    mimeType: query['mimeType'] || undefined,
    uploadSource: query['uploadSource'] as ListFilesRequest['uploadSource'],
    status: query['status'] as ListFilesRequest['status'],
    search: query['search'] || undefined,
    directory: query['directory'] ? validateDirectory(query['directory'], c.env) : undefined,
    recursive: query['recursive'] === 'true',
    sortBy: query['sortBy'] as ListFilesRequest['sortBy'],
    sortOrder: query['sortOrder'] as ListFilesRequest['sortOrder'],
    cursor: query['cursor'] || undefined,
    limit: query['limit'] ? parseInt(query['limit'], 10) : undefined,
  };

  const mayReadDebugPackages = userMayReadDebugPackages(auth.user.role);
  const result = await listFiles(
    db,
    c.env,
    projectId,
    filters,
    debugPackageListOptions(mayReadDebugPackages)
  );
  return c.json(result, 200);
});

// ---------------------------------------------------------------------------
// GET /directories — list subdirectories
// NOTE: Must be registered BEFORE /:fileId to avoid being shadowed
// ---------------------------------------------------------------------------

libraryRoutes.get('/directories', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectAccess(db, projectId, userId);

  const rawParent = c.req.query('parentDirectory') || '/';
  const parentDirectory = validateDirectory(rawParent, c.env);
  const search = c.req.query('search') || undefined;
  validateSearchLength(search, c.env);
  const directories = await listDirectories(db, projectId, parentDirectory, c.env, search);
  const visible = userMayReadDebugPackages(auth.user.role)
    ? directories
    : directories.filter((d) => !isDebugPackageDirectory(`${d.path.replace(/\/$/, '')}/`));

  return c.json({ directories: visible }, 200);
});

// ---------------------------------------------------------------------------
// GET /:fileId — get file metadata
// ---------------------------------------------------------------------------

libraryRoutes.get('/:fileId', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const fileId = requireParam(c.req.param('fileId'), 'fileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectAccess(db, projectId, userId);

  const result = await getFile(db, projectId, fileId);
  assertDebugPackageVisibleTo(auth.user.role, result.file.directory);
  return c.json(result, 200);
});

// ---------------------------------------------------------------------------
// GET /:fileId/download — decrypt + stream file
// ---------------------------------------------------------------------------

libraryRoutes.get('/:fileId/download', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const fileId = requireParam(c.req.param('fileId'), 'fileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectAccess(db, projectId, userId);

  // Stored size bounds the plaintext, so small downloads share the memory budget.
  const { file: stored } = await getFile(db, projectId, fileId);
  assertDebugPackageVisibleTo(auth.user.role, stored.directory);
  const encryptionKey = getEncryptionKey(c.env);
  const timeoutMs = getDownloadTimeoutMs(c.env);
  const owned = await loadLibraryDownload(
    () => downloadFile(db, c.env.R2, encryptionKey, projectId, fileId, stored.sizeBytes),
    timeoutMs,
    stored.sizeBytes
  );
  try {
    const { data, file } = owned.value;
    assertDebugPackageVisibleTo(auth.user.role, file.directory);
    const headers = {
      'Content-Type': downloadContentType(file.mimeType),
      'Content-Length': String(data.byteLength),
      'Content-Disposition': `attachment; filename="${contentDispositionFilename(file.filename)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (c.req.method === 'HEAD') {
      owned.dispose();
      return new Response(null, { status: 200, headers });
    }
    return new Response(owned.stream(), { status: 200, headers });
  } catch (error) {
    owned.dispose();
    throw error;
  }
});

libraryRoutes.post(
  '/:fileId/interactive-preview-url',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const auth = getAuth(c);
    const userId = auth.user.id;
    const projectId = requireParam(c.req.param('projectId'), 'projectId');
    const fileId = requireParam(c.req.param('fileId'), 'fileId');
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectAccess(db, projectId, userId);

    const { file } = await getFile(db, projectId, fileId);
    if (resolveEffectiveMimeType(file.mimeType, file.filename) !== 'text/html') {
      throw errors.badRequest('Only HTML files support interactive preview');
    }
    const previewMaxBytes = parseInt(
      c.env.FILE_PREVIEW_MAX_BYTES ?? String(LIBRARY_DEFAULTS.FILE_PREVIEW_MAX_BYTES),
      10
    );
    if (file.sizeBytes > previewMaxBytes) {
      throw errors.badRequest('File is too large for interactive preview');
    }
    if (!c.env.PREVIEW_SIGNING_KEY) {
      throw errors.internal('Interactive preview signing is not configured');
    }
    const expiresAt = Math.floor(Date.now() / 1000) + getPreviewUrlTtlSeconds(c.env);
    const path = await mintPreviewPath(
      { projectId, fileId, version: file.updatedAt, expiresAt },
      c.env.PREVIEW_SIGNING_KEY
    );
    return c.json({
      url: `https://${getPreviewHostname(c.env)}${path}`,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      version: file.updatedAt,
    });
  }
);

// ---------------------------------------------------------------------------
// GET /:fileId/preview — decrypt + serve inline for previewable types
// ---------------------------------------------------------------------------

libraryRoutes.get('/:fileId/preview', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const fileId = requireParam(c.req.param('fileId'), 'fileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectAccess(db, projectId, userId);

  // Check MIME type BEFORE decrypting to avoid wasting CPU on unsupported types.
  // When the stored type is octet-stream/empty (agent uploads whose type was
  // derived on a minimal image without /etc/mime.types), recover the effective
  // type from the filename extension. Safety is preserved: text/html is always
  // served as inert text/plain with a strict CSP below, and image/svg+xml is not
  // inline-previewable (rejected here) — so no extension-sniffed HTML/SVG is
  // ever served in a way the browser would execute.
  const { file } = await getFile(db, projectId, fileId);
  assertDebugPackageVisibleTo(auth.user.role, file.directory);
  const effectiveMime = resolveEffectiveMimeType(file.mimeType, file.filename);
  if (!isInlinePreviewable(effectiveMime)) {
    throw errors.badRequest('File type is not supported for inline preview');
  }

  // Enforce size limit before decrypting (reuse the configurable load-max from file-utils)
  const previewMaxBytes = parseInt(
    c.env.FILE_PREVIEW_MAX_BYTES ?? String(LIBRARY_DEFAULTS.FILE_PREVIEW_MAX_BYTES),
    10
  );
  if (file.sizeBytes > previewMaxBytes) {
    throw errors.badRequest('File is too large for inline preview');
  }

  const encryptionKey = getEncryptionKey(c.env);
  const timeoutMs = getDownloadTimeoutMs(c.env);
  // Stored size bounds the plaintext, so small previews share the memory budget.
  const owned = await loadLibraryDownload(
    () => downloadFile(db, c.env.R2, encryptionKey, projectId, fileId, file.sizeBytes),
    timeoutMs,
    file.sizeBytes
  );
  try {
    const { data } = owned.value;
    if (!hasPreviewableContent(effectiveMime, data)) {
      throw errors.badRequest('File type is not supported for inline preview');
    }

    const { contentType, contentSecurityPolicy } = previewHeaders(effectiveMime, c.env);
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${contentDispositionFilename(file.filename)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': contentSecurityPolicy,
      'Accept-Ranges': 'bytes',
    };
    const range = parseByteRange(c.req.header('Range'), data.byteLength);
    if (range === 'unsatisfiable') {
      headers['Content-Range'] = `bytes */${data.byteLength}`;
      owned.dispose();
      return new Response(null, { status: 416, headers });
    }
    const start = range ? range.start : 0;
    const end = range ? range.end + 1 : data.byteLength;
    headers['Content-Length'] = String(end - start);
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${data.byteLength}`;
    if (c.req.method === 'HEAD') {
      owned.dispose();
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    return new Response(owned.stream(start, end), { status: range ? 206 : 200, headers });
  } catch (error) {
    owned.dispose();
    throw error;
  }
});

// ---------------------------------------------------------------------------
// DELETE /:fileId — delete file
// ---------------------------------------------------------------------------

libraryRoutes.delete('/:fileId', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const fileId = requireParam(c.req.param('fileId'), 'fileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'project:update');

  await deleteFile(db, c.env.R2, projectId, fileId);

  return c.json({ success: true }, 200);
});

// ---------------------------------------------------------------------------
// PATCH /:fileId/move — move file to a different directory/filename
// ---------------------------------------------------------------------------

libraryRoutes.patch(
  '/:fileId/move',
  requireAuth(),
  requireApproved(),
  jsonValidator(MoveFileSchema),
  async (c) => {
    const auth = getAuth(c);
    const userId = auth.user.id;
    const projectId = requireParam(c.req.param('projectId'), 'projectId');
    const fileId = requireParam(c.req.param('fileId'), 'fileId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'project:update');

    const body = c.req.valid('json');

    if (!body.directory && !body.filename) {
      throw errors.badRequest('Must provide "directory" or "filename" (or both)');
    }

    const result = await moveFile(db, c.env, projectId, fileId, body);

    return c.json(result, 200);
  }
);

// ---------------------------------------------------------------------------
// POST /:fileId/tags — add/remove tags
// ---------------------------------------------------------------------------

libraryRoutes.post(
  '/:fileId/tags',
  requireAuth(),
  requireApproved(),
  jsonValidator(UpdateTagsSchema),
  async (c) => {
    const auth = getAuth(c);
    const userId = auth.user.id;
    const projectId = requireParam(c.req.param('projectId'), 'projectId');
    const fileId = requireParam(c.req.param('fileId'), 'fileId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'project:update');

    const body = c.req.valid('json');

    if (!body.add && !body.remove) {
      throw errors.badRequest('Must provide "add" or "remove" arrays');
    }

    const tags = await updateTags(db, c.env, projectId, fileId, body);

    return c.json({ tags }, 200);
  }
);

export { libraryRoutes };
