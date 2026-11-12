// Moved to @simple-agent-manager/agent-email (worker modularization W6). This file keeps the
// old import path; functions that need worker services bind agentEmailPorts(env).
import * as pkg from '@simple-agent-manager/agent-email';

import type { Env } from '../../env';
import { agentEmailPorts } from './ports';

export {
  loadEmailTriggerConfig,
  parseAllowedSenders,
  toEmailTriggerConfig,
} from '@simple-agent-manager/agent-email';

export function requireAgentEmailOn(env: Env) {
  return pkg.requireAgentEmailOn(env, agentEmailPorts(env));
}

export function resolveAllowedSenders(
  db: Parameters<typeof pkg.resolveAllowedSenders>[0],
  env: Env,
  userId: string,
  requested: string[] | undefined
) {
  return pkg.resolveAllowedSenders(db, agentEmailPorts(env), userId, requested);
}
