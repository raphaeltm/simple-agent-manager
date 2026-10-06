import { PLATFORM_AI_MODELS, type PlatformAIModelTier } from './ai-services';

/**
 * The budget-tier domain an admin's `AdminAiAllowance.allowedModelTiers` ranges over.
 * Typed as a `Record` over the union, so adding a tier to `PlatformAIModelTier` does not compile
 * until it is listed here as well.
 */
const TIER_DOMAIN = {
  'low-cost': true,
  standard: true,
  premium: true,
} as const satisfies Record<PlatformAIModelTier, true>;

/** Every budget tier a platform model can carry. */
export const PLATFORM_AI_MODEL_TIERS = Object.keys(TIER_DOMAIN) as PlatformAIModelTier[];

/** Own-property check, so inherited names such as `toString` are never mistaken for a tier. */
export function isPlatformAIModelTier(value: unknown): value is PlatformAIModelTier {
  return typeof value === 'string' && Object.hasOwn(TIER_DOMAIN, value);
}

const TIER_BY_MODEL_ID: ReadonlyMap<string, PlatformAIModelTier> = new Map(
  PLATFORM_AI_MODELS.map((model) => [model.id, model.tier])
);

/**
 * The budget tier of a platform catalog model, or `null` for an ID the catalog does not list
 * (an operator-added `AI_PROXY_ALLOWED_MODELS` entry, an undated alias, a retired model). Callers
 * enforcing a tier restriction must treat `null` as "not provably allowed".
 */
export function getPlatformAIModelTier(modelId: string): PlatformAIModelTier | null {
  return TIER_BY_MODEL_ID.get(modelId) ?? null;
}
