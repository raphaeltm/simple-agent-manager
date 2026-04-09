/**
 * Project File Library API routes.
 *
 * All routes are scoped to a project and require authentication + project ownership.
 * Mounted at /api/projects/:projectId/library
 */

import type { ListFilesRequest, UpdateTagsRequest } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import { getAuth, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import type { Env } from '../index';
import {
  deleteFile,
  downloadFile,
  getFile,
  getUploadMaxBytes,
  listFiles,
  replaceFile,
  updateTags,
  uploadFile,
  validateFilename,
} from '../services/file-library';

const libraryRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Helper: get encryption key
// ---------------------------------------------------------------------------

function getEncryptionKey(env: Env): string {
  const key = env.CREDENTIAL_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY;
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
  validateFilename(filename);

  const mimeType = (formData['mimeType'] as string) || file.type || 'application/octet-stream';
  const description = formData['description'] as string | undefined;
  const tagsRaw = formData['tags'] as string | undefined;
  const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  const uploadSource = (formData['uploadSource'] as string) || 'user';
  const uploadSessionId = formData['uploadSessionId'] as string | undefined;
  const uploadTaskId = formData['uploadTaskId'] as string | undefined;

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
  validateFilename(filename);

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
    sortBy: query['sortBy'] as ListFilesRequest['sortBy'],
    sortOrder: query['sortOrder'] as ListFilesRequest['sortOrder'],
    cursor: query['cursor'] || undefined,
    limit: query['limit'] ? parseInt(query['limit'], 10) : undefined,
  };

  const result = await listFiles(db, c.env, projectId, filters);
  return c.json(result, 200);
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
  const { data, file } = await downloadFile(db, c.env.R2, encryptionKey, projectId, fileId);

  // Sanitize filename for Content-Disposition
  const safeFilename = file.filename.replace(/[^\x20-\x7E]/g, '_');

  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': file.mimeType,
      'Content-Length': String(data.byteLength),
      'Content-Disposition': `attachment; filename="${safeFilename}"`,
      'Cache-Control': 'private, no-store',
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
