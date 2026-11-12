// Moved to @simple-agent-manager/ai-proxy (worker modularization W5). Re-exported so the
// worker's existing importers are unchanged. Request auth stays in the worker
// (./ai-proxy-auth) and is re-exported here as before.
export {
  buildAIGatewayMetadata,
  buildAnthropicCountTokensUrl,
  buildAnthropicGatewayUrl,
  buildWorkersAIGatewayUrl,
  fetchWorkersAIChatCompletion,
  isAnthropicModel,
  readSafeGatewayErrorDiagnostic,
  WorkersAIGatewayError,
} from '@simple-agent-manager/ai-proxy';

export {
  AIProxyAuthError,
  type AIProxyAuthResult,
  type AIProxyCredentialAttribution,
  extractCallbackToken,
  updateAIProxyAgentCredentialAttribution,
  verifyAIProxyAuth,
} from './ai-proxy-auth';
