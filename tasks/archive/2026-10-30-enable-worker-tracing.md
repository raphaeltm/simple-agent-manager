# Enable automatic API Worker tracing

## Problem
Admin page investigation found a canceled 114-second request with only 7ms CPU. Logs lack dependency timings. User authorized enabling native Cloudflare traces at 100% sampling for investigation.

## Research
- `scripts/deploy/sync-wrangler-config.ts` currently generates logs-only observability for staging and production.
- `scripts/deploy/types.ts` needs trace configuration types. Keep native top-level Wrangler trace overrides so self-hosters can lower sampling or disable capture without editing the generator.
- Automatic tracing instruments D1/KV/fetch/DO operations without an SDK. No application logic or VM provisioning changes are needed.
- Traces retain seven days. Shared ingestion/storage billing starts December 1, 2026; document the sampling and billing tradeoff.

## Checklist
- [x] Generate enabled traces with explicit 100% sampling; preserve top-level trace overrides.
- [x] Extend deployment types and test generated TOML for staging/prod, reduced sampling and disabled tracing.
- [x] Redact query strings in generated observability config so callback/terminal credentials are not retained.
- [x] Document setup, overrides, retention and billing reference.
- [x] Run relevant validation and independent local specialist reviews.
- [x] Verify staging trace configuration and captured dependency spans. (Staging run 41082816507 on `d6c1587e5`: traces enabled, rate 1, persisted, query redaction on; trace `c4de347b3d263d8d884151699863da8a` has a native `d1_first` span; recorded in the #2477 body.)
- [x] Merge after CI/review and verify production deployment/configuration and new traces. (Merged as `e7e5edef3`; Deploy Production 41088475230 succeeded; production trace `dd515f607a1abe4e77a57738d1542929` has `d1_run`, `d1_all`, Durable Object storage and RPC spans, checked 2026-10-30 17:11 UTC.)

## Acceptance criteria
- Staging and production generated configs enable persisted native traces by default at rate 1.
- Native trace config overrides survive generation, including rate 0 and disabled capture.
- Existing log configuration remains unchanged.
- Actual staging and production telemetry contains new traces after deployment.

## References
- https://developers.cloudflare.com/workers/observability/traces/
- https://developers.cloudflare.com/observability/pricing/

## Validation evidence
- Focused generator suite: 66 tests passed (1 file); generated TOML round-trip verifies staging/prod trace defaults, override tests include 0%, 5%, disabled, external destination/persistence.
- Deployment scripts TypeScript check passed.
- Task-only main push rejected by required-check protection; task record kept on PR branch.
- ESLint, formatting, deployment tsc and public docs build passed (266 pages). Independent Cloudflare/constitution/docs review passed.
- Completion validator A/B/C/F passed; D/E not applicable. Release telemetry remains pending.

## Review follow-up
CodeRabbit identified query credential retention risk. Added observability.redact_query_string=true for generated environments, type coverage and assertions; docs clarify metadata remaining after redaction. Staging old-head retry still running; final redacted configuration must be verified before production.

## Reconciliation 2026-11-02

Shipped. #2477 merged as `e7e5edef3` on 2026-10-30 and Deploy Production run 41088475230
succeeded. Staging and production trace evidence is in the #2477 body under "Staging Verification
Evidence" and "Production Verification". Moved from `tasks/active/` to `tasks/archive/` by the
2026-11-02 weekly queue reconciliation.
