/**
 * Project File Library API routes.
 *
 * All routes are scoped to a project and require authentication + project ownership.
 * Mounted at /api/projects/:projectId/library
 */

import type { ListFilesRequest, MoveFileRequest, UpdateTagsRequest } from '@simple-agent-manager/shared';
import { LIBRARY_DEFAULTS } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getAuth, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import {
  deleteFile,
  downloadFile,
  getDownloadTimeoutMs,
  getFile,
  getUploadMaxBytes,
  listDirectories,
  listFiles,
  moveFile,
  replaceFile,
  updateTags,
  uploadFile,
  validateDirectory,
  validateFilename,
} from '../services/file-library';

const libraryRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Helper: get encryption key
// ---------------------------------------------------------------------------

function getEncryptionKey(env: Env): string {
  const key = env.LIBRARY_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY;
  if (!key) {
    throw errors.internal('Encryption key not configured');
  }
  return key;
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) {
    throw errors.badRequest(`Missing required parameter: ${name}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// POST /upload — multipart file upload
// ---------------------------------------------------------------------------

libraryRoutes.post('/upload', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  // Parse multipart form data
  let formData: Record<string, string | File>;
  try {
    formData = await c.req.parseBody();
  } catch {
    throw errors.badRequest('Failed to parse multipart form data');
  }

  const file = formData['file'];
  if (!(file instanceof File)) {
    throw errors.badRequest('Missing "file" field in multipart form data');
  }

  // Check file size before reading
  const maxBytes = getUploadMaxBytes(c.env);
  if (file.size > maxBytes) {
    throw errors.badRequest(`File exceeds maximum size of ${maxBytes} bytes`);
  }

  const filename = (formData['filename'] as string) || file.name || 'unnamed';
  validateFilename(filename, c.env);

  const mimeType = (formData['mimeType'] as string) || file.type || 'application/octet-stream';
  const description = formData['description'] as string | undefined;
  const tagsRaw = formData['tags'] as string | undefined;
  const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  const uploadSource = (formData['uploadSource'] as string) || 'user';
  const uploadSessionId = formData['uploadSessionId'] as string | undefined;
  const uploadTaskId = formData['uploadTaskId'] as string | undefined;
  const directory = formData['directory'] as string | undefined;

  const data = await file.arrayBuffer();
  const encryptionKey = getEncryptionKey(c.env);

  const result = await uploadFile(
    db, c.env.R2, encryptionKey, c.env, projectId, userId,
    filename, mimeType, data,
    {
      description,
      tags,
      uploadSource: uploadSource === 'agent' ? 'agent' : 'user',
      uploadSessionId,
      uploadTaskId,
      directory,
    }
  );

  return c.json(result, 201);
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

  await requireOwnedProject(db, projectId, userId);

  let formData: Record<string, string | File>;
  try {
    formData = await c.req.parseBody();
  } catch {
    throw errors.badRequest('Failed to parse multipart form data');
  }

  const file = formData['file'];
  if (!(file instanceof File)) {
    throw errors.badRequest('Missing "file" field in multipart form data');
  }

  const filename = (formData['filename'] as string) || file.name || 'unnamed';
  validateFilename(filename, c.env);

  const mimeType = (formData['mimeType'] as string) || file.type || 'application/octet-stream';
  const description = formData['description'] as string | undefined;

  const data = await file.arrayBuffer();
  const encryptionKey = getEncryptionKey(c.env);

  const result = await replaceFile(
    db, c.env.R2, encryptionKey, c.env, projectId, fileId, userId,
    filename, mimeType, data,
    { description }
  );

  return c.json(result, 200);
});

// ---------------------------------------------------------------------------
// GET / — list files with filters
// ---------------------------------------------------------------------------

libraryRoutes.get('/', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const query = c.req.query();
  const filters: ListFilesRequest = {
    tags: query['tags'] ? query['tags'].split(',').map((t) => t.trim()).filter(Boolean) : undefined,
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

  const result = await listFiles(db, c.env, projectId, filters);
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

  await requireOwnedProject(db, projectId, userId);

  const rawParent = c.req.query('parentDirectory') || '/';
  const parentDirectory = validateDirectory(rawParent, c.env);
  const search = c.req.query('search') || undefined;
  const directories = await listDirectories(db, projectId, parentDirectory, c.env, search);

  return c.json({ directories }, 200);
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

  await requireOwnedProject(db, projectId, userId);

  const result = await getFile(db, projectId, fileId);
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

  await requireOwnedProject(db, projectId, userId);

  const encryptionKey = getEncryptionKey(c.env);
  const timeoutMs = getDownloadTimeoutMs(c.env);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const { data, file } = await Promise.race([
    downloadFile(db, c.env.R2, encryptionKey, projectId, fileId),
    new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(errors.internal('Download timed out')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeoutHandle));

  // Sanitize filename for Content-Disposition (strip non-printable + header-unsafe chars)
  const safeFilename = file.filename.replace(/[^\x20-\x7E]|["\\;]/g, '_');

  // Force safe Content-Type for MIME types that can execute scripts in browsers
  const DANGEROUS_MIMES = ['text/html', 'application/javascript', 'application/xhtml+xml', 'image/svg+xml', 'text/xml'];
  const contentType = DANGEROUS_MIMES.includes(file.mimeType.toLowerCase())
    ? 'application/octet-stream'
    : file.mimeType;

  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(data.byteLength),
      'Content-Disposition': `attachment; filename="${safeFilename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// ---------------------------------------------------------------------------
// GET /:fileId/preview — decrypt + serve inline for previewable types
// ---------------------------------------------------------------------------

/** MIME types safe to render inline in a browser (images, PDF, markdown).
 *  Keep in sync with PREVIEWABLE_IMAGE_MIMES + PREVIEWABLE_MIMES in apps/web/src/lib/file-utils.ts */
const PREVIEWABLE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'text/markdown',
]);

libraryRoutes.get('/:fileId/preview', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const fileId = requireParam(c.req.param('fileId'), 'fileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  // Check MIME type BEFORE decrypting to avoid wasting CPU on unsupported types
  const { file } = await getFile(db, projectId, fileId);
  const mimeTypeLower = (file.mimeType.split(';')[0] ?? file.mimeType).trim().toLowerCase();
  if (!PREVIEWABLE_MIMES.has(mimeTypeLower)) {
    throw errors.badRequest('File type is not supported for inline preview');
  }

  // Enforce size limit before decrypting (reuse the configurable load-max from file-utils)
  const previewMaxBytes = parseInt(
    c.env.FILE_PREVIEW_MAX_BYTES ?? String(LIBRARY_DEFAULTS.FILE_PREVIEW_MAX_BYTES),
    10,
  );
  if (file.sizeBytes > previewMaxBytes) {
    throw errors.badRequest('File is too large for inline preview');
  }

  const encryptionKey = getEncryptionKey(c.env);
  const timeoutMs = getDownloadTimeoutMs(c.env);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const { data } = await Promise.race([
    downloadFile(db, c.env.R2, encryptionKey, projectId, fileId),
    new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(errors.internal('Preview timed out')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeoutHandle));

  const safeFilename = file.filename.replace(/[^\x20-\x7E]|["\\;]/g, '_');

  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': mimeTypeLower,
      'Content-Length': String(data.byteLength),
      'Content-Disposition': `inline; filename="${safeFilename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // PDF viewers need script-src for browser-native rendering; images get strict CSP
      'Content-Security-Policy': mimeTypeLower === 'application/pdf'
        ? "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'self'"
        : "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
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

  await requireOwnedProject(db, projectId, userId);

  await deleteFile(db, c.env.R2, projectId, fileId);

  return c.json({ success: true }, 200);
});

// ---------------------------------------------------------------------------
// PATCH /:fileId/move — move file to a different directory/filename
// ---------------------------------------------------------------------------

libraryRoutes.patch('/:fileId/move', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const fileId = requireParam(c.req.param('fileId'), 'fileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const body = await c.req.json<MoveFileRequest>();

  if (!body.directory && !body.filename) {
    throw errors.badRequest('Must provide "directory" or "filename" (or both)');
  }

  const result = await moveFile(db, c.env, projectId, fileId, body);

  return c.json(result, 200);
});

// ---------------------------------------------------------------------------
// POST /:fileId/tags — add/remove tags
// ---------------------------------------------------------------------------

libraryRoutes.post('/:fileId/tags', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const fileId = requireParam(c.req.param('fileId'), 'fileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const body = await c.req.json<UpdateTagsRequest>();

  if (!body.add && !body.remove) {
    throw errors.badRequest('Must provide "add" or "remove" arrays');
  }

  const tags = await updateTags(db, c.env, projectId, fileId, body);

  return c.json({ tags }, 200);
});

export { libraryRoutes };
