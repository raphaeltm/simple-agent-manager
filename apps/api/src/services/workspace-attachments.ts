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
  userId: string;
  nodeId: string;
  workspaceId: string;
  attachments: TaskAttachment[];
  beforeTransfer?: () => Promise<void>;
}): Promise<void> {
  const { env, userId, nodeId, workspaceId, attachments } = input;
  if (attachments.length === 0) return;
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
    const object = await getAttachmentFromR2(env.R2, userId, attachment);
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    const body = new FormData();
    body.append('files', new Blob([bytes], { type: object.contentType }), attachment.filename);
    // Omitting destination retains the VM-agent's private sibling directory default.
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
  await cleanupAttachments(env.R2, userId, attachments);
}
