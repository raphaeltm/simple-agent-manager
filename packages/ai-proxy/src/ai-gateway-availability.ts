/**
 * Whether this installation can route AI calls through Cloudflare AI Gateway, and what follows
 * from that. Pure functions of the environment; the worker's platform-capability module
 * (`apps/api/src/services/platform-capabilities.ts`) re-exports them so there is one answer.
 */
import type { AiProxyEnv } from './env';

function present(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Account-scoped Cloudflare REST API (Workers AI REST, Analytics SQL, Observability). */
export function hasCloudflareAccountApi(
  env: Partial<Pick<AiProxyEnv, 'CF_ACCOUNT_ID' | 'CF_API_TOKEN'>>
): boolean {
  return present(env.CF_ACCOUNT_ID) && present(env.CF_API_TOKEN);
}

/**
 * The AI Gateway id to route through, or null when the gateway cannot be addressed.
 *
 * `AI_GATEWAY_ID` alone is not the condition: `wrangler.toml` ships a default id, so a
 * runtime with no Cloudflare account still has it set. Every gateway URL is
 * `gateway.ai.cloudflare.com/v1/<account>/<gateway>/...`, so it also needs the account id.
 */
export function resolveAiGatewayId(
  env: Partial<Pick<AiProxyEnv, 'AI_GATEWAY_ID' | 'CF_ACCOUNT_ID'>>
): string | null {
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  if (!gatewayId || !present(env.CF_ACCOUNT_ID)) return null;
  return gatewayId;
}

/**
 * Whether SAM prices AI calls itself (catalog list price x reported usage) and stores the result
 * in the per-user `AiTokenBudgetCounter`. True exactly when there is no addressable AI Gateway:
 * there the gateway's logs are the spend record (`runMonthlyCostAggregation`), and a second,
 * co-equal record would disagree with it (rule 74). Without one SAM's own record is the only one.
 */
export function hasLocalAiCostMetering(
  env: Partial<Pick<AiProxyEnv, 'AI_GATEWAY_ID' | 'CF_ACCOUNT_ID'>>
): boolean {
  return resolveAiGatewayId(env) === null;
}

/**
 * Whether a monthly AI dollar cap can be enforced here.
 *
 * - With an AI Gateway the month's spend comes from gateway logs, read by
 *   `runMonthlyCostAggregation` through the account API (gateway id, account id and API token all
 *   required). A gateway without the account API cannot be priced, so the cap is reported
 *   unavailable there rather than accepted and silently never enforced.
 * - Without a gateway SAM meters platform-billed proxy calls and SAM agent calls itself
 *   (`hasLocalAiCostMetering`) and the cap reads that total (`getLocalMonthlyAiCostUsd`). Calls to
 *   a model with no catalog price (an operator's own endpoint model) count $0.
 *
 * Calls served by an admin-configured OpenAI-compatible endpoint never reach gateway logs, so on
 * an installation with both, the cap counts only gateway-routed spend (documented in
 * reference/configuration.md). Daily token budgets apply either way.
 */
export function isMonthlyCostCapAvailable(
  env: Partial<Pick<AiProxyEnv, 'AI_GATEWAY_ID' | 'CF_ACCOUNT_ID' | 'CF_API_TOKEN'>>
): boolean {
  if (hasLocalAiCostMetering(env)) return true;
  return hasCloudflareAccountApi(env);
}

/**
 * AI Gateway request headers (`cf-aig-metadata` attribution with user and workspace ids), or
 * nothing when the call goes straight to the provider. Only the gateway reads them, so a
 * direct call to OpenAI or Anthropic must not carry SAM's internal ids.
 */
export function aiGatewayOnlyHeaders(
  env: Partial<Pick<AiProxyEnv, 'AI_GATEWAY_ID' | 'CF_ACCOUNT_ID'>>,
  headers: Record<string, string>
): Record<string, string> {
  return resolveAiGatewayId(env) ? headers : {};
}
