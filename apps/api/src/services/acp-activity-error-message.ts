import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';

const DEFAULT_AGENT_ACTIVITY_ERROR_MESSAGE_MAX_LENGTH = 2048;

function agentActivityErrorMessageMaxLength(env: Env): number {
  return parsePositiveInt(
    env.SESSION_LIFECYCLE_ERROR_MAX_LENGTH,
    DEFAULT_AGENT_ACTIVITY_ERROR_MESSAGE_MAX_LENGTH
  );
}

function truncateAgentErrorMessage(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

export function normalizeAgentActivityErrorMessage(
  env: Env,
  statusError: string | null | undefined
): string {
  const detail = truncateAgentErrorMessage(
    statusError?.trim() || 'Agent reported an error before producing a response',
    agentActivityErrorMessageMaxLength(env)
  );
  if (/^agent (startup )?failed/i.test(detail)) return detail;
  return `Agent failed: ${detail}`;
}
