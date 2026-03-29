/**
 * Task Attachment Upload Route — Presigned URL generation for R2 direct uploads.
 *
 * POST /api/projects/:projectId/tasks/request-upload
 *
 * Generates a presigned PUT URL that the browser uses to upload a file directly
 * to R2. The Worker is not in the upload path — only in the URL generation path.
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import {
  ATTACHMENT_DEFAULTS,
  SAFE_FILENAME_REGEX,
} from '@simple-agent-manager/shared';
import type { RequestAttachmentUploadRequest, RequestAttachmentUploadResponse } from '@simple-agent-manager/shared';
import type { Env } from '../../index';
import * as schema from '../../db/schema';
import { getAuth, requireAuth, requireApproved } from '../../middleware/auth';
import { requireOwnedProject } from '../../middleware/project-auth';
import { errors } from '../../middleware/error';
import { ulid } from '../../lib/ulid';
import { log } from '../../lib/logger';
import { generatePresignedUploadUrl } from '../../services/attachment-upload';

const uploadRoutes = new Hono<{ Bindings: Env }>();

uploadRoutes.use('/*', requireAuth(), requireApproved());

/**
 * POST /projects/:projectId/tasks/request-upload
 *
 * Generate a presigned R2 URL for direct browser upload of a task attachment.
 * Returns 200 with { uploadId, uploadUrl, r2Key, expiresIn }.
 */
uploadRoutes.post('/:projectId/tasks/request-upload', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  // Validate project ownership
  await requireOwnedProject(db, projectId, userId);

  // Check R2 S3 credentials are configured
  if (!c.env.R2_ACCESS_KEY_ID || !c.env.R2_SECRET_ACCESS_KEY) {
    throw errors.forbidden('File attachments are not configured (R2 S3 credentials missing)');
  }

  const body = await c.req.json<RequestAttachmentUploadRequest>();

  // Validate required fields
  if (!body.filename || typeof body.filename !== 'string') {
    throw errors.badRequest('filename is required');
  }
  if (!body.size || typeof body.size !== 'number' || body.size <= 0) {
    throw errors.badRequest('size must be a positive number');
  }
  if (!body.contentType || typeof body.contentType !== 'string') {
    throw errors.badRequest('contentType is required');
  }

  // Validate filename safety
  if (!SAFE_FILENAME_REGEX.test(body.filename)) {
    throw errors.badRequest('Filename contains unsafe characters. Only alphanumeric, dots, dashes, underscores, and spaces are allowed.');
  }

  // Validate file size limit
  const maxBytes = c.env.ATTACHMENT_UPLOAD_MAX_BYTES
    ? parseInt(c.env.ATTACHMENT_UPLOAD_MAX_BYTES, 10)
    : ATTACHMENT_DEFAULTS.UPLOAD_MAX_BYTES;
  if (body.size > maxBytes) {
    throw errors.badRequest(`File size ${body.size} exceeds maximum ${maxBytes} bytes`);
  }

  const uploadId = ulid();

  const result = await generatePresignedUploadUrl(c.env, {
    userId,
    uploadId,
    filename: body.filename,
    size: body.size,
    contentType: body.contentType,
  });

  log.info('tasks.request_upload', {
    userId,
    projectId,
    uploadId,
    filename: body.filename,
    size: body.size,
  });

  const response: RequestAttachmentUploadResponse = {
    uploadId,
    uploadUrl: result.uploadUrl,
    r2Key: result.r2Key,
    expiresIn: result.expiresIn,
  };

  return c.json(response, 200);
});

export { uploadRoutes };
