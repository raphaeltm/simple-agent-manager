// Moved to @simple-agent-manager/agent-email (worker modularization W6). This file keeps the
// old import path; functions that need worker services bind agentEmailPorts(env).
import * as pkg from '@simple-agent-manager/agent-email';

import type { Env } from '../../env';
import { type AgentEmailPortOverrides, agentEmailPorts } from './ports';

export { type InboundEmailMessage } from '@simple-agent-manager/agent-email';

export function handleInboundAgentEmail(
  message: pkg.InboundEmailMessage,
  env: Env,
  deps: pkg.InboundDeps & AgentEmailPortOverrides = {}
) {
  const { submitter, ...inboundDeps } = deps;
  return pkg.handleInboundAgentEmail(
    message,
    env,
    agentEmailPorts(env, { submitter }),
    inboundDeps
  );
}
