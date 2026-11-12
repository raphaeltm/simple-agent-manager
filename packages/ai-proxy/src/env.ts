/**
 * The bindings and variables the AI proxy package reads. The worker `Env` extends this
 * interface; no package function takes the full worker environment.
 */
export interface AiProxyEnv {
  KV: KVNamespace;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  AI_TOKEN_BUDGET_COUNTER?: DurableObjectNamespace;
  AI_PROXY_DAILY_INPUT_TOKEN_LIMIT?: string; // Per-user daily input token cap (default: 500000)
  AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT?: string; // Per-user daily output token cap (default: 200000)
  AI_PROXY_BILLING_MODE?: string; // Billing mode: "unified" | "platform-key" | "auto" (default: auto)
  AI_MONTHLY_COST_CACHE_TTL_SECONDS?: string; // TTL for monthly cost KV cache entries in seconds (default: 7200, min: 60, max: 86400, invalid values fall back)
  AI_MONTHLY_COST_AGGREGATION_MAX_PAGES?: string; // Max AI Gateway log pages for monthly cost cron (default: 200, hard cap: 500, invalid values fall back)
  AI_GATEWAY_ID?: string; // Cloudflare AI Gateway ID (set by deployment from resource prefix)
  CF_AIG_TOKEN?: string; // Cloudflare AI Gateway Unified Billing token (optional — enables all providers without separate keys)
  AI_USAGE_PAGE_SIZE?: string; // AI Gateway logs page size for usage aggregation (1-50, default: 50, invalid values fall back)
  AI_USAGE_MAX_PAGES?: string; // Max pages to iterate for AI usage aggregation (default: 20, hard cap: 20, invalid values fall back)
  AI_USAGE_MAX_DAILY_TOKEN_LIMIT?: string; // Max daily token limit a user can set (default: 10000000)
  AI_USAGE_MIN_DAILY_TOKEN_LIMIT?: string; // Min daily token limit a user can set (default: 1000)
  AI_USAGE_MAX_MONTHLY_COST_CAP_USD?: string; // Max monthly cost cap (USD) a user can set (default: 10000)
  AI_USAGE_MIN_MONTHLY_COST_CAP_USD?: string; // Min monthly cost cap (USD) a user can set (default: 0.01)
  AI_USAGE_BUDGET_TTL_SECONDS?: string; // KV TTL for daily budget entries (default: 90000)
}
