/** User-facing AI Gateway usage response (GET /api/usage/ai). */
export interface UserAiUsageResponse {
  totalCostUsd: number;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cachedRequests: number;
  errorRequests: number;
  byModel: UserAiUsageByModel[];
  byDay: UserAiUsageByDay[];
  period: string;
  periodLabel: string;
}

export interface UserAiUsageByModel {
  model: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cachedRequests: number;
  errorRequests: number;
}

export interface UserAiUsageByDay {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
