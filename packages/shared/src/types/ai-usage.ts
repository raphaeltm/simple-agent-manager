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

// ---------------------------------------------------------------------------
// Admin AI Allowance Ceilings (per-user, managed by admins)
// ---------------------------------------------------------------------------

/** Admin-managed AI allowance ceiling for a user (stored in KV). */
export interface AdminAiAllowance {
  /** Max daily input tokens the user can set. null = use platform default ceiling. */
  maxDailyInputTokens: number | null;
  /** Max daily output tokens the user can set. null = use platform default ceiling. */
  maxDailyOutputTokens: number | null;
  /** Max monthly spend USD the user can set. null = use platform default ceiling. */
  maxMonthlyCostCapUsd: number | null;
  /** Allowed model tiers. null = all tiers allowed. */
  allowedModelTiers: string[] | null;
  /** When the allowance was last updated (ISO string). */
  updatedAt: string;
  /** Admin user ID who set the allowance. */
  updatedBy: string;
}

/** API response for GET /api/admin/users/:userId/ai-allowance. */
export interface AdminAiAllowanceResponse {
  userId: string;
  allowance: AdminAiAllowance | null;
  effectiveCeiling: {
    maxDailyInputTokens: number;
    maxDailyOutputTokens: number;
    maxMonthlyCostCapUsd: number;
  };
}

/** Request body for PUT /api/admin/users/:userId/ai-allowance. */
export interface UpdateAdminAiAllowanceRequest {
  maxDailyInputTokens?: number | null;
  maxDailyOutputTokens?: number | null;
  maxMonthlyCostCapUsd?: number | null;
  allowedModelTiers?: string[] | null;
}
