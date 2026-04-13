/**
 * Task Attachment Upload Route — Presigned URL generation for R2 direct uploads.
 *
 * POST /api/projects/:projectId/tasks/request-upload  (full mounted path)
 *
 * Generates a presigned PUT URL that the browser uses to upload a file directly
 * to R2. The Worker is not in the upload path — only in the URL generation path.
 */
import type { RequestAttachmentUploadResponse } from '@simple-agent-manager/shared';
import {
  ATTACHMENT_DEFAULTS,
  SAFE_FILENAME_REGEX,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { getAuth, requireApproved,requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject } from '../../middleware/project-auth';
import { jsonValidator, RequestAttachmentUploadSchema } from '../../schemas';
import { generatePresignedUploadUrl } from '../../services/attachment-upload';

const uploadRoutes = new Hono<{ Bindings: Env }>();

uploadRoutes.use('/*', requireAuth(), requireApproved());

/**
 * POST /request-upload
 *
 * Generate a presigned R2 URL for direct browser upload of a task attachment.
 * Mounted under /api/projects/:projectId/tasks, so full path is:
 *   POST /api/projects/:projectId/tasks/request-upload
 * Returns 200 with { uploadId, uploadUrl, r2Key, expiresIn }.
 */
uploadRoutes.post('/request-upload', jsonValidator(RequestAttachmentUploadSchema), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  // projectId comes from the parent route mount: /api/projects/:projectId/tasks
  const projectId = c.req.param('projectId');
  if (!projectId) {
    throw errors.badRequest('projectId is required');
  }
  const db = drizzle(c.env.DATABASE, { schema });

  // Validate project ownership
  await requireOwnedProject(db, projectId, userId);

  // Check R2 S3 credentials are configured
  if (!c.env.R2_ACCESS_KEY_ID || !c.env.R2_SECRET_ACCESS_KEY) {
    throw errors.forbidden('File attachments are not configured (R2 S3 credentials missing)');
  }

  const body = c.req.valid('json');

  // Structure validated by schema; check business rules
  if (body.size <= 0) {
    throw errors.badRequest('size must be a positive number');
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
    expiresIn: result.expiresIn,
  };

  return c.json(response, 200);
});

export { uploadRoutes };
