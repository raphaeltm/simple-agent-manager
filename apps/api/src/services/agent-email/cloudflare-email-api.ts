// Moved to @simple-agent-manager/agent-email (worker modularization W6). This file keeps the
// old import path; functions that need worker services bind agentEmailPorts(env).
import * as pkg from '@simple-agent-manager/agent-email';

import type { Env } from '../../env';
import { agentEmailPorts } from './ports';

export { CloudflareEmailApiError } from '@simple-agent-manager/agent-email';

export function listSendingSubdomains(env: Env, options?: pkg.EmailReadOptions) {
  return pkg.listSendingSubdomains(env, agentEmailPorts(env), options);
}
