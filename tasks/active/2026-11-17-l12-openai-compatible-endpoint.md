# L12 — OpenAI-compatible LLM endpoint and AI proxy availability

## Problem and scope
Land C12/C13 from sam/selfhost-pass-2 on fresh main (L3 #2733, L11 #2820, L5a #2751). An admin endpoint replaces Workers AI and SAM agent routing; proxy availability follows actual gateway configuration or explicit direct-upstream consent after authentication. Preserve current usage attribution and unrelated main changes. No self-host-only implementation.

## Preflight and research
Classes: external-api-change, cross-component-change, business-logic-change, security-sensitive-change, docs-sync-change. Existing OpenAI chat protocol and guardedFetch are reused; no dependencies or model catalog changes. The integration version forces include_usage and moves fetch logic out of packages/ai-proxy; port selectively instead. Settings use the existing module-scoped AdminSettingsCache (bounded 60s TTL, shared single-flight, mutation generation fencing). Do not add an independent stale cache. L11 owns the capability predicate; no credential read on the unconfigured path, and no additional D1 read per call with a warm snapshot. A configured endpoint outage refuses routing rather than sending prompts to another provider. Bound settings work separately within title/diagnosis budgets. Existing L5a task documents credential parse resilience and the production custom-URL precheck; recheck read-only before C13.

Data flow: Admin settings registry -> platform_settings/platform_credentials -> L11 capability -> worker endpoint adapter -> packages/ai-proxy target/fetch helpers -> Workers AI proxy, task-title and SAM agent consumers. Workspace callback -> lifecycle-auth -> availability -> model and budget admission -> guarded provider fetch. Agent-key proxies custom URLs or returns 404, retaining raw/JSON credential tolerance.

Rule 74: condition is an operator-enabled proxy with an addressable gateway or explicit direct-upstream opt-in. Signal is presence of all gateway inputs, not AI_GATEWAY_ID alone. Divergence: gateway id set but account/token missing must require opt-in; healthy complete Cloudflare configuration remains available without settings reads. Tests cover divergence/convergence and 401 before availability.

## Checklist and acceptance
- [ ] Reconfirm production custom-baseURL row count read-only; record count.
- [ ] Port endpoint definitions and shared target helpers on package seam; wire L11 capability and cached settings with bounded reads.
- [ ] Workers AI calls and SAM agent use endpoint first; configured settings failure refuses (503 proxy); Cloudflare unconfigured read-count regression.
- [ ] Wire title/diagnosis/project-model callers; fix F26 (bounded settings, no unused enforced, one cap predicate, no forced include_usage).
- [ ] Centralize proxy availability after auth; preserve #2674 unauthenticated 401.
- [ ] Direct-upstream paths; agent-key 404 when custom endpoint is not served, malformed-row controls.
- [ ] Split passthrough to <=500 lines, guard all 3 fetches, reduce outbound baseline by 3, redirect regression tests.
- [ ] Focused behavioral and cross-boundary tests with discriminating guards; lint/typecheck/test/build.
- [ ] Docs reflect settings and behavior, no unrelated spec edits.
- [ ] Draft PR, then complete candidate ready + CodeRabbit request; required local security, Cloudflare, performance and completion reviews.
- [ ] Check both staging leases, reserve and follow queue, deploy final candidate; live 401, SAM-mode chat, title generation, SAM agent, refused-private endpoint routing then reset settings; cleanup/release.
- [ ] Full CI and review gates pass, merge authorized by coordinator; channel PR/blocker/completion evidence; idea update with PR and commit. Coordinator monitors production deployment.

## References
Idea 01M72M9AEB933ZY8269D376DKC; task 01M7KNA1CNRHWG13CMNB2SVMP5; coordinator 01M7JMXS2JRW6QQMB1356ENPM3; channel feature.selfhost-landing. Rules 18, 41, 60, 62, 74; L5a retained incident/production precheck in tasks/active/2026-11-15-l5-outbound-fetch-guard.md.
