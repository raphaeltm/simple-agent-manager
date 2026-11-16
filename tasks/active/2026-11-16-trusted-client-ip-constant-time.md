# L5b: trusted client IP and constant-time comparison

Task: 01M7JNC96XV9DTRFV9TK14GEDP. Landing idea: 01M72M9AEB933ZY8269D376DKC.

## Problem and scope
Land only the integration branch's shared inbound IP and comparison helpers onto fresh main, porting callers by hand. No cherry-picks, self-host runtime, proxy settings, or unrelated branch changes. Coordinator authorizes merge after all /do gates.

## Preflight and findings
Classification: security-sensitive-change, business-logic-change, cross-component-change, docs-sync-change.
Main 10ec60b9c has 13 explicit IP readers, plus BetterAuth's default IP resolver. Some callers fall back to untrusted XFF. The branch helper trusts only ingress-overwritten CF-Connecting-IP, validates literals, and returns null on absence/malformed input, causing rate limits to share unknown. Trusted proxies must overwrite this same header from the peer and prevent direct ingress bypass; no forwarding-header mode is added.
The branch's constant-time helper extracts the existing setup-token comparator. Audit all touched files for other secret equality checks. Main moved provider-specific code into packages; enumerate current apps and packages rather than copy old call-site files.
Rule 74: trusted peer attribution is the condition; header presence alone is not evidence of trusted ingress. CF overwrites the header; another ingress must enforce equivalent ownership. XFF/X-Real-IP diverge because callers can send them.
Rule 77 incident: mocked BetterAuth missed an OAuth hook contract. Use real BetterAuth to assert persisted session IP under spoofed forwarding headers, including a failure control.
Data flow: request -> clientIpFromHeaders -> rate-limit key / diagnostics / node heartbeat / VM-hop XFF; createAuth advanced.ipAddress -> BetterAuth session persistence. Setup token -> constantTimeEqual -> authorization result.
Documentation: architecture/security.md header contract and missing-IP behavior. Constitution X/XI/XIII: reuse branch helpers, no tunables/dependencies added, missing trusted IP fails closed.

## Implementation checklist
- [x] Copy four specified helper/test files from origin/sam/selfhost-pass-2 without history.
- [x] Port every current IP reader and BetterAuth ipAddressHeaders by hand.
- [x] Extract setup-token comparison; audit touched files and centralize additional secret/token equality.
- [x] Add constant-time tests: UTF-8, unequal lengths, zero bytes, differences.
- [x] Test Cloudflare spoof rejection, trusted ingress, malformed/missing input, and reader enumeration including packages.
- [x] Test real BetterAuth persistence and rate limiting with spoofed XFF; prove regression tests red before fix.
- [x] Update public security docs and respect file/size budgets.
- [ ] Run lint, typecheck, tests and build; specialist reviews and completion validator.
- [ ] Check both staging queues, reserve and deploy on turn; Playwright sign-in, stored IP and rate-limit key checks; release.
- [ ] Ready PR, request/wait CodeRabbit, resolve reviews, green CI, merge and production smoke.
- [ ] Publish PR/blockers/completion to channel; update idea with PR/commit.

## Acceptance criteria
Valid Cloudflare IP strings remain unchanged; XFF/X-Real-IP never supply client IP. Trusted ingress's overwritten CF header resolves correctly. Every explicit reader uses the helper; BetterAuth trusts the same header. Touched secret comparisons use the helper and preserve denial behavior. Added non-test code stays below ~1,200 lines; modified sources respect rule 18. Security-auditor, cloudflare-specialist, task-completion-validator complete with findings addressed. Staging proves stored session IP and rate-limit key use actual client despite spoof XFF. All /do gates pass before merge.

## Validation evidence
Baseline pnpm lint and typecheck passed (existing web hook warnings only). Before fixes, real OAuth tests: 3 failed / 7 passed, storing spoof XFF; reader/rate tests: 3 failed / 14 passed. After fixes: 5 files, 69 tests passed. BetterAuth IPv6 /64 and test-mode localhost normalization retained. API-wide secret equality audit: no additional secret/token equality in touched files beyond setup-token comparator; ID/type/status comparisons remain ordinary equality. Node heartbeat IP/DNS extracted in separate refactor commit: node-lifecycle.ts now 481 lines, auth.ts 494. No additional I/O: helper runs once per former header reader, pure bounded parsing; BetterAuth config resolves on existing createAuth path.
