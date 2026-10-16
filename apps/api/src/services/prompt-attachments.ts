import * as v from 'valibot';

import type { PromptDeliveryClaim } from '../durable-objects/project-data/prompt-delivery';
import type { Env } from '../env';
import { TaskAttachmentSchema } from '../schemas/tasks';
import { validateAttachments } from './attachment-upload';
import type { VmPromptDeliveryTarget } from './vm-prompt-delivery-target';
import { transferWorkspaceAttachments } from './workspace-attachments';

/** Runs only after wake/readiness, before any prompt submission. */
export async function transferPromptAttachments(
  env: Env,
  claim: PromptDeliveryClaim,
  target: VmPromptDeliveryTarget,
  beforeTransfer: () => Promise<void>
): Promise<void> {
  if (claim.message.sourceKind !== 'user_followup') return;
  const raw = claim.message.metadata?.attachments;
  if (raw === undefined) return;
  const attachments = v.parse(v.array(TaskAttachmentSchema), raw);
  if (attachments.length === 0) return;
  // Ownership comes from the authenticated sender, never caller-supplied metadata.
  if (claim.message.senderType !== 'human' || claim.message.senderId !== target.userId) {
    throw new Error('Attachment sender does not own the target workspace');
  }
  const validation = await validateAttachments(env, target.userId, attachments);
  if (!validation.valid) throw new Error(validation.errors.join('; '));
  await transferWorkspaceAttachments({
    env,
    userId: target.userId,
    nodeId: target.nodeId,
    workspaceId: target.workspaceId,
    attachments,
    retainStaged: true,
    beforeTransfer,
  });
}
