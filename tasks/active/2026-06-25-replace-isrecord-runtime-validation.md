# Replace local isRecord guards with runtime validation

## Problem

The codebase has repeated local `isRecord` helpers that manually validate unknown JSON-like payloads. SAM already uses Valibot and shared runtime-validation helpers, so these local guards should be replaced with schema-based runtime validation or existing validation helpers.

## Research Findings

- `rg -n "\bisRecord\b" .` found 42 hits across 8 files.
- Production/runtime paths should prefer named schemas or shared runtime-validation helpers.
- One-off scripts and experiments still benefit from Valibot because they parse external JSON from GitHub, Pulumi, Cloudflare, and model APIs.
- Existing helpers:
  - `apps/api/src/lib/runtime-validation.ts`
  - `apps/web/src/lib/runtime-validation.ts`

## Implementation Checklist

- [x] Replace `apps/api/src/durable-objects/project-orchestrator/scheduling.ts` local `isRecord` parsing.
- [x] Replace `apps/web/src/pages/sam-prototype/onboarding-cards.tsx` local `isRecord` parsing.
- [x] Replace `scripts/deploy/sync-wrangler-config.ts` local `isRecord` parsing.
- [x] Replace `scripts/quality/check-preflight-evidence.ts` local `isRecord` parsing.
- [x] Replace `scripts/quality/check-specialist-review-evidence.ts` local `isRecord` parsing.
- [x] Replace `scripts/quality/check-observability-noise.ts` local `isRecord` parsing.
- [x] Replace `experiments/ai-gateway-tool-call/experiment.ts` local `isRecord` parsing.
- [x] Replace `experiments/harness-eval/runner.ts` local `isRecord` parsing.
- [x] Confirm `rg -n "\bisRecord\b" apps scripts experiments packages` has no remaining local helper usage.
- [x] Run focused validation checks.

## Acceptance Criteria

- No local `isRecord` helpers remain in the files identified above.
- Unknown JSON boundaries use Valibot schemas or existing runtime-validation helpers.
- Existing behavior is preserved where parsers tolerate optional/missing fields.
- Typecheck and focused tests pass.
