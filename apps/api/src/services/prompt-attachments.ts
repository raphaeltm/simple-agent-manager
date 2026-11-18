import * as v from 'valibot';

import type { PromptDeliveryClaim } from '../durable-objects/project-data/prompt-delivery';
import type { Env } from '../env';
import { TaskAttachmentSchema } from '../schemas/tasks';
import { validateAttachments } from './attachment-upload';
import type { VmPromptDeliveryTarget } from './vm-prompt-delivery-target';
import { transferWorkspaceAttachments } from './workspace-attachments';

/**
 * Whose uploads a prompt's attachments are: the sender's, who must be the target workspace's
 * owner or a teammate the chat is shared with. The sender is the authenticated person who sent
 * the prompt, and `onBehalfOfUserId` is the owner `sendChat` recorded for a teammate's prompt;
 * both are server-written, never caller-supplied. Whether the teammate's access is still active
 * is the delivery fence's job: it runs before every transfer (`beforeTransfer`) and before the
 * send (idea 01M59MYE4GY91BWTE8TZF1ZB5D).
 */
function attachmentUploader(claim: PromptDeliveryClaim, target: VmPromptDeliveryTarget): string {
  const sender = claim.message.senderType === 'human' ? claim.message.senderId : null;
  if (sender && sender === target.userId) return sender;
  if (sender && claim.message.metadata?.onBehalfOfUserId === target.userId) return sender;
  throw new Error('Attachment sender does not own the target workspace');
}

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
  const uploaderUserId = attachmentUploader(claim, target);
  const validation = await validateAttachments(env, uploaderUserId, attachments);
  if (!validation.valid) throw new Error(validation.errors.join('; '));
  // Only into the shared chat's own workspace: the token is for that workspace and its owner.
  await transferWorkspaceAttachments({
    env,
    userId: target.userId,
    uploaderUserId,
    nodeId: target.nodeId,
    workspaceId: target.workspaceId,
    attachments,
    retainStaged: true,
    beforeTransfer,
  });
}
