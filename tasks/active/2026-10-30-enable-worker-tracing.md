# Enable automatic API Worker tracing

## Problem
Admin page investigation found a canceled 114-second request with only 7ms CPU. Logs lack dependency timings. User authorized enabling native Cloudflare traces at 100% sampling for investigation.

## Research
- `scripts/deploy/sync-wrangler-config.ts` currently generates logs-only observability for staging and production.
- `scripts/deploy/types.ts` needs trace configuration types. Keep native top-level Wrangler trace overrides so self-hosters can lower sampling or disable capture without editing the generator.
- Automatic tracing instruments D1/KV/fetch/DO operations without an SDK. No application logic or VM provisioning changes are needed.
- Traces retain seven days. Shared ingestion/storage billing starts December 1, 2026; document the sampling and billing tradeoff.

## Checklist
- [ ] Generate enabled traces with explicit 100% sampling; preserve top-level trace overrides.
- [ ] Extend deployment types and test generated TOML for staging/prod, reduced sampling and disabled tracing.
- [ ] Document setup, overrides, retention and billing reference.
- [ ] Run relevant validation and independent local specialist reviews.
- [ ] Verify staging trace configuration and captured dependency spans.
- [ ] Merge after CI/review and verify production deployment/configuration and new traces.

## Acceptance criteria
- Staging and production generated configs enable persisted native traces by default at rate 1.
- Native trace config overrides survive generation, including rate 0 and disabled capture.
- Existing log configuration remains unchanged.
- Actual staging and production telemetry contains new traces after deployment.

## References
- https://developers.cloudflare.com/workers/observability/traces/
- https://developers.cloudflare.com/observability/pricing/
