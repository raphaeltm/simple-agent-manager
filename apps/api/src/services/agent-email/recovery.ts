// Moved to @simple-agent-manager/agent-email (worker modularization W6). This file keeps the
// old import path; functions that need worker services bind agentEmailPorts(env).
import * as pkg from '@simple-agent-manager/agent-email';

import type { Env } from '../../env';
import { type AgentEmailPortOverrides, agentEmailPorts } from './ports';

export { type AgentEmailRecoveryStats } from '@simple-agent-manager/agent-email';

export function runAgentEmailRecovery(
  env: Env,
  waitUntil?: (work: Promise<unknown>) => void,
  options: Omit<pkg.AttemptOptions, 'refuseBusy'> & AgentEmailPortOverrides = {}
) {
  const { submitter, ...attemptOptions } = options;
  return pkg.runAgentEmailRecovery(
    env,
    agentEmailPorts(env, { submitter }),
    waitUntil,
    attemptOptions
  );
}
