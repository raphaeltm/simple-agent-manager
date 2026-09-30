import {
  ACP_INTERACTION_PROTOCOL_VERSION,
  type AcpInteractionRuntimeConfig,
  DEFAULT_ACP_INTERACTION_DEADLINE_MARGIN_MS,
  DEFAULT_ACP_INTERACTION_PERMISSION_CONVERSATION_DEADLINE_MS,
  DEFAULT_ACP_INTERACTION_PERMISSION_TASK_DEADLINE_MS,
  DEFAULT_ACP_INTERACTION_OPTION_ID_MAX_CHARS,
  DEFAULT_ACP_INTERACTION_RUNTIME_RECEIPT_LIMIT,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { getAcpInteractionConfig } from './acp-interaction-config';

export function buildAcpInteractionRuntimeConfig(
  env: Env,
  taskMode: string | null | undefined
): AcpInteractionRuntimeConfig {
  const config = getAcpInteractionConfig(env);
  return {
    enabled: config.enabled,
    protocolVersion: ACP_INTERACTION_PROTOCOL_VERSION,
    permissionDeadlineMs:
      taskMode === 'conversation'
        ? DEFAULT_ACP_INTERACTION_PERMISSION_CONVERSATION_DEADLINE_MS
        : DEFAULT_ACP_INTERACTION_PERMISSION_TASK_DEADLINE_MS,
    maxDeadlineMs: config.maxDeadlineMs,
    deadlineMarginMs: DEFAULT_ACP_INTERACTION_DEADLINE_MARGIN_MS,
    requestMaxBytes: config.requestMaxBytes,
    optionsMaxCount: config.optionsMaxCount,
    optionIdMaxChars: DEFAULT_ACP_INTERACTION_OPTION_ID_MAX_CHARS,
    optionNameMaxChars: config.optionNameMaxChars,
    receiptLimit: DEFAULT_ACP_INTERACTION_RUNTIME_RECEIPT_LIMIT,
    settleRetryDelaysMs: config.retryDelaysMs,
    settleRetrySteadyMs: config.retrySteadyMs,
  };
}
