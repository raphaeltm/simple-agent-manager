import type { ModelAllowedScope, PlatformAIModel, ToolCallSupport } from './ai-services';

/** Minimum tool-call support level required for agent loop participation. */
export const AGENT_LOOP_MIN_TOOL_CALL_SUPPORT: ToolCallSupport = 'good';

/**
 * Filter models suitable for agent loop execution.
 *
 * Returns models with tool-call reliability greater than or equal to `minSupport`
 * and optionally filters by allowed execution scope.
 */
export function filterModelsForAgentLoop(
  models: PlatformAIModel[],
  options?: { scope?: ModelAllowedScope; minSupport?: ToolCallSupport }
): PlatformAIModel[] {
  const minSupport = options?.minSupport ?? AGENT_LOOP_MIN_TOOL_CALL_SUPPORT;
  const supportLevels: ToolCallSupport[] = ['excellent', 'good', 'limited', 'none'];
  const minIndex = supportLevels.indexOf(minSupport);

  return models.filter((model) => {
    const modelIndex = supportLevels.indexOf(model.toolCallSupport);
    if (modelIndex > minIndex) return false;
    if (options?.scope && !model.allowedScopes.includes(options.scope)) return false;
    return true;
  });
}
