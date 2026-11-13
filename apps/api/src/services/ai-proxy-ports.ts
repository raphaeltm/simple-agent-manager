// Worker implementation of @simple-agent-manager/ai-proxy's ports, bound to one environment.
import type { AiProxyPorts } from '@simple-agent-manager/ai-proxy';
import { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { resolveAdminSetting } from './admin-settings-resolution';
import { getPlatformAgentCredential } from './platform-credentials';

/**
 * Bind the AI proxy ports to `env`. Pass `db` when the caller already holds a drizzle handle,
 * so platform-key billing reads through the same connection it always did.
 */
export function aiProxyPorts(env: Env, db?: ReturnType<typeof drizzle>): AiProxyPorts {
  return {
    getPlatformAnthropicKey: async () => {
      const cred = await getPlatformAgentCredential(
        db ?? drizzle(env.DATABASE),
        'claude-code',
        getCredentialEncryptionKey(env)
      );
      return cred ? { credentialId: cred.credentialId, credential: cred.credential } : null;
    },
    externalReadTimeoutMs: async () =>
      Number(await resolveAdminSetting(env, 'performance.externalReadTimeoutMs')),
  };
}
