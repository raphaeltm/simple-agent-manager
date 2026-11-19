// Moved to @simple-agent-manager/ai-proxy (worker modularization W5). Named re-exports plus a
// wrapper with the original signature that binds the worker's ports.
import * as pkg from '@simple-agent-manager/ai-proxy';
import type { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../env';
import { aiProxyPorts } from './ai-proxy-ports';

export {
  resolveBillingMode,
  resolveUnifiedBillingToken,
  type UpstreamAuth,
} from '@simple-agent-manager/ai-proxy';

/** Resolve upstream AI Gateway auth; platform-key mode reads the credential through `db`. */
export function resolveUpstreamAuth(
  env: Env,
  db: ReturnType<typeof drizzle>
): Promise<pkg.UpstreamAuth> {
  return pkg.resolveUpstreamAuth(env, aiProxyPorts(env, db));
}
