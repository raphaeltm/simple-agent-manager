import type { TaskAttachment } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { cleanupAttachments, getAttachmentFromR2 } from './attachment-upload';
import { signTerminalToken } from './jwt';
import { fetchNodeAgent } from './node-agent';
import { getNodeBackendBaseUrl } from './node-agent-readiness';

const DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS = 60_000;

/** One authorized transfer path for VM and Instant workspaces. */
export async function transferWorkspaceAttachments(input: {
  env: Env;
  /** The workspace's owner: the transfer token is theirs. */
  userId: string;
  /**
   * Whose uploads these are, when not the workspace owner's: a teammate's prompt in a chat
   * shared with them (prompt-attachments.ts). Uploads live under the uploader's R2 prefix.
   */
  uploaderUserId?: string;
  nodeId: string;
  workspaceId: string;
  attachments: TaskAttachment[];
  /** Keep staged bytes available for durable delivery retries until R2 lifecycle expiry. */
  retainStaged?: boolean;
  beforeTransfer?: () => Promise<void>;
}): Promise<void> {
  const { env, userId, nodeId, workspaceId, attachments } = input;
  if (attachments.length === 0) return;
  const uploaderUserId = input.uploaderUserId ?? userId;
  const { token } = await signTerminalToken(userId, workspaceId, env);
  const timeoutMs = parsePositiveInt(
    env.ATTACHMENT_TRANSFER_TIMEOUT_MS,
    DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS
  );
  const uploadUrl = new URL(
    `/workspaces/${workspaceId}/files/upload`,
    getNodeBackendBaseUrl(nodeId, env)
  );
  uploadUrl.searchParams.set('token', token);
  for (const attachment of attachments) {
    const object = await getAttachmentFromR2(env.R2, uploaderUserId, attachment);
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    const body = new FormData();
    body.append('destination', `/workspaces/.private/${attachment.uploadId}`);
    body.append('files', new Blob([bytes], { type: object.contentType }), attachment.filename);
    const response = await fetchNodeAgent(
      nodeId,
      env,
      uploadUrl.toString(),
      {
        method: 'POST',
        body,
      },
      timeoutMs,
      { beforeExternalMutation: input.beforeTransfer }
    );
    if (!response.ok) {
      throw Object.assign(
        new Error(`Attachment transfer failed for ${attachment.filename}: ${response.status}`),
        {
          permanent: response.status >= 400 && response.status < 500,
        }
      );
    }
  }
  if (!input.retainStaged) await cleanupAttachments(env.R2, uploaderUserId, attachments);
}
