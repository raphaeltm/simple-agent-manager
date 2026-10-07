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
    formsEnabled: config.enabled && config.formsEnabled && taskMode === 'conversation',
    urlsEnabled: config.enabled && config.urlsEnabled && taskMode === 'conversation',
    protocolVersion: ACP_INTERACTION_PROTOCOL_VERSION,
    permissionDeadlineMs:
      taskMode === 'conversation'
        ? config.permissionConversationDeadlineMs
        : config.permissionTaskDeadlineMs,
    formDeadlineMs: config.permissionConversationDeadlineMs,
    urlDeadlineMs: config.urlDeadlineMs,
    urlMaxChars: config.urlMaxChars,
    urlElicitationIdMaxChars: config.urlElicitationIdMaxChars,
    urlRedirectDepth: config.urlRedirectDepth,
    maxDeadlineMs: config.maxDeadlineMs,
    deadlineMarginMs: config.deadlineMarginMs,
    requestMaxBytes: config.requestMaxBytes,
    optionsMaxCount: config.optionsMaxCount,
    optionIdMaxChars: config.optionIdMaxChars,
    optionNameMaxChars: config.optionNameMaxChars,
    receiptLimit: config.runtimeReceiptLimit,
    responseMaxBytes: config.runtimeResponseMaxBytes,
    formSchemaMaxBytes: config.formSchemaMaxBytes,
    formSchemaMaxProperties: config.formSchemaMaxProperties,
    formSchemaMaxEnum: config.formSchemaMaxEnum,
    answerMaxBytes: config.answerMaxBytes,
    answerStringMaxBytes: config.answerStringMaxBytes,
    settleRetryDelaysMs: config.retryDelaysMs,
    settleRetrySteadyMs: config.retrySteadyMs,
  };
}
