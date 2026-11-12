// Moved to @simple-agent-manager/agent-email (worker modularization W6). This file keeps the
// old import path; functions that need worker services bind agentEmailPorts(env).
import * as pkg from '@simple-agent-manager/agent-email';

import type { Env } from '../../env';
import { type AgentEmailPortOverrides, agentEmailPorts } from './ports';

export {
  type AttemptOptions,
  type DeliveryContext,
  type DeliveryOutcome,
} from '@simple-agent-manager/agent-email';

export function attemptDelivery(
  env: Env,
  context: pkg.DeliveryContext,
  delivery: pkg.ClaimedDelivery,
  options: pkg.AttemptOptions & AgentEmailPortOverrides
) {
  const { submitter, ...attemptOptions } = options;
  return pkg.attemptDelivery(
    agentEmailPorts(env, { submitter }),
    context,
    delivery,
    attemptOptions
  );
}
