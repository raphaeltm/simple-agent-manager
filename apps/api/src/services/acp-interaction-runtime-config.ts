import {
  ACP_INTERACTION_PROTOCOL_VERSION,
  type AcpInteractionRuntimeConfig,
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
        ? config.permissionConversationDeadlineMs
        : config.permissionTaskDeadlineMs,
    maxDeadlineMs: config.maxDeadlineMs,
    deadlineMarginMs: config.deadlineMarginMs,
    requestMaxBytes: config.requestMaxBytes,
    optionsMaxCount: config.optionsMaxCount,
    optionIdMaxChars: config.optionIdMaxChars,
    optionNameMaxChars: config.optionNameMaxChars,
    receiptLimit: config.runtimeReceiptLimit,
    responseMaxBytes: config.runtimeResponseMaxBytes,
    settleRetryDelaysMs: config.retryDelaysMs,
    settleRetrySteadyMs: config.retrySteadyMs,
  };
}
