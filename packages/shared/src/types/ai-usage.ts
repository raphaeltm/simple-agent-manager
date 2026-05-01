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

// ---------------------------------------------------------------------------
// User-configurable budget settings (stored in KV)
// ---------------------------------------------------------------------------

/** User-configurable AI budget settings (GET/PUT /api/usage/ai/budget). */
export interface UserAiBudgetSettings {
  /** Daily input token limit. null = use platform default. */
  dailyInputTokenLimit: number | null;
  /** Daily output token limit. null = use platform default. */
  dailyOutputTokenLimit: number | null;
  /** Monthly cost cap in USD. null = unlimited. */
  monthlyCostCapUsd: number | null;
  /** Alert threshold as percentage (0-100). Default: 80. */
  alertThresholdPercent: number;
}

/** Budget response combining settings + current utilization. */
export interface UserAiBudgetResponse {
  /** Current budget settings (user-set or defaults). */
  settings: UserAiBudgetSettings;
  /** Whether the user has custom settings (vs. platform defaults). */
  isCustom: boolean;
  /** Current daily token usage. */
  dailyUsage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Effective daily limits (user-set or platform default). */
  effectiveLimits: {
    dailyInputTokenLimit: number;
    dailyOutputTokenLimit: number;
  };
  /** Current month's estimated cost from AI Gateway. */
  monthCostUsd: number;
  /** Utilization percentages (0-100). */
  utilization: {
    dailyInputPercent: number;
    dailyOutputPercent: number;
    monthlyCostPercent: number | null;
  };
  /** Whether any limit is currently exceeded. */
  exceeded: boolean;
}

/** Request body for PUT /api/usage/ai/budget. */
export interface UpdateAiBudgetRequest {
  dailyInputTokenLimit?: number | null;
  dailyOutputTokenLimit?: number | null;
  monthlyCostCapUsd?: number | null;
  alertThresholdPercent?: number;
}
