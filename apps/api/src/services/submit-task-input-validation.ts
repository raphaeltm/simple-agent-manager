import type { TaskAttachment } from '@simple-agent-manager/shared';
import {
  ATTACHMENT_DEFAULTS,
  MAX_CONTEXT_SUMMARY_BYTES,
  SAFE_FILENAME_REGEX,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import type { TaskSubmitOperation } from '../lib/task-submit-diagnostics';
import { errors } from '../middleware/error';
import { validateAttachments } from './attachment-upload';

/**
 * Validate a task submission's context summary and attachments before any task effect.
 * Returns the attachments to persist (empty when none were sent).
 */
export async function validateSubmitContextAndAttachments(
  env: Env,
  userId: string,
  body: Readonly<{ contextSummary?: string; attachments?: TaskAttachment[] }>,
  setOperation: (operation: TaskSubmitOperation) => void
): Promise<TaskAttachment[]> {
  // Validate contextSummary size if provided
  if (body.contextSummary) {
    const summaryBytes = new TextEncoder().encode(body.contextSummary).length;
    if (summaryBytes > MAX_CONTEXT_SUMMARY_BYTES) {
      throw errors.badRequest(
        `contextSummary exceeds maximum size of ${MAX_CONTEXT_SUMMARY_BYTES} bytes`
      );
    }
  }

  if (!body.attachments || body.attachments.length === 0) return [];

  // Validate attachment structure
  const maxFiles = env.ATTACHMENT_MAX_FILES
    ? parseInt(env.ATTACHMENT_MAX_FILES, 10)
    : ATTACHMENT_DEFAULTS.MAX_FILES;
  if (body.attachments.length > maxFiles) {
    throw errors.badRequest(
      `Too many attachments: ${body.attachments.length} exceeds maximum ${maxFiles}`
    );
  }

  // Structure validated by schema; check filename safety
  for (const att of body.attachments) {
    if (!SAFE_FILENAME_REGEX.test(att.filename)) {
      throw errors.badRequest(`Unsafe filename in attachment: ${att.filename}`);
    }
  }

  // Validate attachments exist in R2 and match declared sizes
  setOperation('attachment_validation');
  const validation = await validateAttachments(env, userId, body.attachments);
  if (!validation.valid) {
    throw errors.badRequest(`Attachment validation failed: ${validation.errors.join('; ')}`);
  }

  return body.attachments;
}
