# gpt-5.6-luna catalog price is about 4x what AI Gateway charged

## Problem

`PLATFORM_AI_MODELS` (`packages/shared/src/constants/ai-services.ts`) prices `gpt-5.6-luna` at
$0.001 per 1K input tokens and $0.006 per 1K output tokens. Repricing the two staging AI Gateway
logs for this model (Nov 2026, gateway `sam`, user-attributed) with the catalog gave 4.02x what the
gateway charged: an 11,782-token-input call was logged at $0.0030 against a catalog estimate of
$0.0118, which implies roughly $0.00025 per 1K input tokens. `gpt-5.4-mini` matched within 1.19x.

The catalog price is the spend record for the monthly cap on self-host boxes (no gateway) and the
backstop estimate on gateway installs (`packages/ai-proxy/src/ai-cost-estimate.ts`), so an
overpriced model refuses users early near their cap.

## Context

Found while measuring catalog-versus-gateway divergence for the hosted spending-limit fix (task
01M8BMCD0B9HPZKMJ3VD1WN62Y). The sample is only two calls; cached-input tokens are not split out in
gateway logs, so verify against the provider's published price before changing anything.

## Acceptance Criteria

- [ ] Price verified against OpenAI's live pricing page (rule 52); cite the source in the PR
- [ ] `PLATFORM_AI_MODELS` updated if wrong (input, output and cached-input rates)
- [ ] Other catalog entries spot-checked against recent gateway logs with the same method
- [ ] `packages/shared` model-catalog and ai-model-registry tests still pass
