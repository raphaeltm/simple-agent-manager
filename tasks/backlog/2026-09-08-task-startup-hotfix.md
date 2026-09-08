# Task startup hotfix

## Problem and verified evidence
Production selected a 4096 MiB offering for a 4096 MiB reservation, although final admission reserves512 MiB for the host. No workspace was created; retries oscillated until15-minute timeout. Instant profiles with attachments/idea execution/resource overrides enter task-submit, which omits runtime resolution. Submit HTTP durations reached71/103 seconds while synchronously reconciling provider catalogs and default pools.

## Preflight
Classes: business-logic-change, cross-component-change, docs-sync-change, security-sensitive-change.
Trace: chat handleSubmit -> task-submit -> placement resolver -> TaskRunner -> atomic workspace reservation; Instant -> accept/continueInstantSessionLaunch -> node-agent transport -> agent bootstrap.
Use existing runtime, admission, attachment authorization and launch machinery. No new dependencies, no weakening of final capacity/ownership/credential fences. Read rules05,09,14,69 and constitution. Reviewed current production D1/CF telemetry and restricted summaries of the private debug bundle. MCP Instant routing is existing control path; cover it in validation. New feature fields must propagate end to end.

## Implementation checklist
- [ ] Align provider offering eligibility with final host-reserve policy; reject impossible fresh allocations before provisioning and prevent retry loop.
- [ ] Preserve explicit Instant runtime on task-submit, including attachments, forks and idea execution; validate incompatible VM overrides.
- [ ] Use existing runtime-aware attachment transport and preserve original user message/file context.
- [ ] Eliminate synchronous catalog reconciliation during submission while preserving effective pool precedence and first-install behavior.
- [ ] Investigate revision rejection; preserve legitimate pool invalidation and avoid silently adopting stale authorization.
- [ ] Add regression tests for each boundary and run relevant quality checks.
- [ ] Update public docs; specialist review; staging; CI/CodeRabbit; merge; production verification.

## Acceptance criteria
A4 GiB request cannot provision a4 GiB VM with512 MiB reserve; a fitting request succeeds. Instant selection never becomes VM implicitly because of attachment/idea/resource routing. Existing pools can submit without provider catalog refresh; fresh installations still initialize through supported lifecycle. Failed placement has a bounded actionable outcome. Final pool/credential/isolation checks remain enforced.

## Constraints
User authorizes PR and merge ASAP; simplest safe fix. Stop before reported account allowance falls below15%. Starting allowance28% at22:25Z. Preserve a restartable checkpoint if reached.

## References
SAM incident idea01M21G5K3XNKFBGYNP0T2FPBW4; parent session4760beee-29f9-45b6-9f81-2073788c69e2. No raw diagnostic artifact contents in public artifacts.
