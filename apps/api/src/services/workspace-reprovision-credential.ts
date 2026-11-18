/**
 * Credential handoff for VM workspace restart and rebuild.
 *
 * Restart and rebuild reactivate the same workspace ID under a new runtime. The admission
 * write rotates the workspace's credential generation to the new eviction generation
 * (`reserveWorkspaceRestart`, the rebuild update in `routes/workspaces/lifecycle.ts`), which
 * revokes every callback token the previous runtime held. The new runtime's token travels in
 * the restart/rebuild request over the authenticated node-management channel.
 *
 * A VM agent older than this handoff rejects the extra field with 400 before changing any
 * state (its decoder disallows unknown fields). The restart then fails closed with an
 * explanation instead of reviving the old runtime's credentials.
 */
import type { Env } from '../env';
import { signCallbackToken } from './jwt';
import { NodeAgentHttpError } from './node-agent';

/** Body text of the VM agent's restart/rebuild decode failure (`workspace_reprovision.go`). */
const LEGACY_AGENT_REPROVISION_DECODE_ERROR = 'invalid workspace restart request';

export class WorkspaceReprovisionCredentialUnsupportedError extends Error {
  constructor(operation: 'restart' | 'rebuild') {
    super(
      `The node's VM agent is too old to receive a new workspace credential, so the workspace ` +
        `cannot ${operation} without reusing its previous credentials. Start a new chat or ` +
        `create a new workspace to continue.`
    );
    this.name = 'WorkspaceReprovisionCredentialUnsupportedError';
  }
}

/** Callback token for the runtime a restart or rebuild is about to start. */
export function signReprovisionCallbackToken(
  env: Env,
  workspaceId: string,
  callbackGeneration: string
): Promise<string> {
  return signCallbackToken(workspaceId, env, { callbackGeneration });
}

/** Replace an old agent's decode rejection with an actionable failure; pass others through. */
export function describeReprovisionDispatchError(
  error: unknown,
  operation: 'restart' | 'rebuild'
): unknown {
  if (
    error instanceof NodeAgentHttpError &&
    error.statusCode === 400 &&
    error.responseBody.includes(LEGACY_AGENT_REPROVISION_DECODE_ERROR)
  ) {
    return new WorkspaceReprovisionCredentialUnsupportedError(operation);
  }
  return error;
}
