/**
 * Admin model-tier restriction for the platform AI proxy.
 *
 * A superadmin can limit which budget tiers of the platform model catalog a user may spend
 * platform credentials on (`AdminAiAllowance.allowedModelTiers`, set through
 * `PUT /api/admin/ai-allowance/:userId`); `null` allows every tier. Every proxy route that
 * forwards a user-chosen model upstream on platform credentials asks this gate before it spends —
 * `tests/unit/routes/ai-proxy-model-tier-coverage.test.ts` enforces that.
 *
 * BYO-key passthrough (`routes/ai-proxy-passthrough.ts`) is deliberately not gated: it only ever
 * resolves the user's or project's own attached credential, and tiers classify platform spend.
 */
import { getPlatformAIModelTier, type PlatformAIModelTier } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { getAdminAiAllowance } from './ai-token-budget';

/** The one allowance field this gate reads. Other fields and unknown keys are not its concern. */
const StoredTierRestrictionSchema = v.object({
  allowedModelTiers: v.optional(v.nullable(v.array(v.string()))),
});

export type ModelTierDenial =
  | {
      reason: 'tier_not_allowed';
      modelTier: PlatformAIModelTier;
      allowedTiers: readonly string[];
    }
  | { reason: 'model_not_in_catalog'; allowedTiers: readonly string[] }
  | { reason: 'allowance_unreadable' };

export type ModelTierDecision = { allowed: true } | ({ allowed: false } & ModelTierDenial);

const ALLOWED: ModelTierDecision = { allowed: true };

/**
 * Decides whether `userId` may send `modelId` upstream on platform credentials.
 *
 * Fails closed: a restricted user may use only models the catalog places in an allowed tier, so an
 * ID the catalog does not list is refused, and a stored allowance this gate cannot read is not
 * treated as permission. A KV read that throws propagates, so the request fails without spending.
 */
export async function checkModelTierAllowance(
  kv: KVNamespace,
  userId: string,
  modelId: string
): Promise<ModelTierDecision> {
  const stored: unknown = await getAdminAiAllowance(kv, userId);
  if (stored === null) return ALLOWED;

  const parsed = v.safeParse(StoredTierRestrictionSchema, stored);
  if (!parsed.success) return { allowed: false, reason: 'allowance_unreadable' };

  const allowedTiers = parsed.output.allowedModelTiers ?? null;
  if (allowedTiers === null) return ALLOWED;

  const modelTier = getPlatformAIModelTier(modelId);
  if (modelTier === null) return { allowed: false, reason: 'model_not_in_catalog', allowedTiers };
  if (allowedTiers.includes(modelTier)) return ALLOWED;
  return { allowed: false, reason: 'tier_not_allowed', modelTier, allowedTiers };
}

function listTiers(tiers: readonly string[]): string {
  return tiers.length > 0 ? tiers.join(', ') : 'none';
}

/** The user-facing reason a proxy route returns with its 403. */
export function describeModelTierDenial(modelId: string, denial: ModelTierDenial): string {
  switch (denial.reason) {
    case 'tier_not_allowed':
      return `Model '${modelId}' is in the ${denial.modelTier} tier, which your account is not allowed to use. Allowed tiers: ${listTiers(denial.allowedTiers)}.`;
    case 'model_not_in_catalog':
      return `Model '${modelId}' has no tier in the platform model catalog, and your account is limited to these tiers: ${listTiers(denial.allowedTiers)}.`;
    case 'allowance_unreadable':
      return 'Your account’s AI allowance could not be read, so platform models are unavailable. Contact an administrator.';
  }
}
