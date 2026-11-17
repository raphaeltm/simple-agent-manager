import { type Context } from 'hono';

import type { Env } from '../../env';
import { assertProviderLimitCredentialPin } from '../../services/provider-limit-credential-pin';
import { type WorkspaceDeletionCallbackKind } from '../../services/workspace-deletion-callback-signal';
import {
  assertWorkspaceCallbackIdentityCurrent,
  type WorkspaceCallbackIdentitySnapshot,
} from './_helpers';

type RuntimeContext = Context<{ Bindings: Env }>;
export async function callbackJsonWithJit<T extends Record<string, unknown>>(
  c: RuntimeContext,
  expected: WorkspaceCallbackIdentitySnapshot,
  callback: WorkspaceDeletionCallbackKind,
  body: T
) {
  await assertWorkspaceCallbackIdentityCurrent(c.env, expected, callback);
  if (
    callback === 'agent_key' &&
    body.credentialSource !== 'platform' &&
    typeof body.credentialReference === 'string'
  )
    await assertProviderLimitCredentialPin(
      c.env,
      expected.workspaceId,
      body.credentialReference,
      expected
    );
  return c.json(body);
}
