// Moved to @simple-agent-manager/agent-email (worker modularization W6). This file keeps the
// old import path; functions that need worker services bind agentEmailPorts(env).
import * as pkg from '@simple-agent-manager/agent-email';

import type { Env } from '../../env';
import { agentEmailPorts } from './ports';

export { AgentEmailReplyError } from '@simple-agent-manager/agent-email';

export function replyToTriggerEmail(
  env: Env,
  input: pkg.AgentEmailReplyInput,
  sender: pkg.AgentEmailSender | null,
  now?: Date
) {
  return pkg.replyToTriggerEmail(env, agentEmailPorts(env), input, sender, now);
}
