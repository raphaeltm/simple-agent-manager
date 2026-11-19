// Moved to @simple-agent-manager/agent-email (worker modularization W6). This file keeps the
// old import path; functions that need worker services bind agentEmailPorts(env).
import * as pkg from '@simple-agent-manager/agent-email';

import type { Env } from '../../env';
import { agentEmailPorts } from './ports';

export function planAgentEmailSetup(env: Env) {
  return pkg.planAgentEmailSetup(env, agentEmailPorts(env));
}

export function runAgentEmailSetup(
  env: Env,
  options: Parameters<typeof pkg.runAgentEmailSetup>[2]
) {
  return pkg.runAgentEmailSetup(env, agentEmailPorts(env), options);
}
