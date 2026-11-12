// Moved to @simple-agent-manager/agent-email (worker modularization W6). This file keeps the
// old import path; functions that need worker services bind agentEmailPorts(env).
import * as pkg from '@simple-agent-manager/agent-email';

import type { Env } from '../../env';
import { agentEmailPorts } from './ports';

export {
  AGENT_EMAIL_SETUP_KEY,
  type AgentEmailMailRecord,
  type AgentEmailSetupAttempt,
  type AgentEmailSetupRecord,
  completeAgentEmailSetup,
  hasAgentEmailBinding,
  replaceSetupAttempt,
  type StoredSetupAttempt,
} from '@simple-agent-manager/agent-email';

export function readAgentEmailSetup(env: Env) {
  return pkg.readAgentEmailSetup(agentEmailPorts(env));
}

export function isAgentEmailOn(env: Env) {
  return pkg.isAgentEmailOn(env, agentEmailPorts(env));
}

export function agentEmailConfig(env: Env) {
  return pkg.agentEmailConfig(env, agentEmailPorts(env));
}

export function activeAgentEmailSender(env: Env) {
  return pkg.activeAgentEmailSender(env, agentEmailPorts(env));
}

export function readSetupAttempt(env: Env, domain: string) {
  return pkg.readSetupAttempt(agentEmailPorts(env), domain);
}

export function claimSetupAttempt(env: Env, attempt: pkg.AgentEmailSetupAttempt) {
  return pkg.claimSetupAttempt(env, agentEmailPorts(env), attempt);
}
