# Compression 1.20.5 and blocking WebSocket security dependency (#2999)

## Research and scope
Original compress-only bump failed Go Vulnerability Diff because existing Gorilla1.5.3 uses weak mask randomness (GO-2026-6278). Official advisory names v1.5.4-0.20240701034025-d67f41855da4 as first fixed. Preserve compression1.20.5; add exactly that security fix and patched x/net0.63.0/x/text0.44.0/x/sync0.25.0 transitives. Normal main merge preserves original history. No application source, configuration, or public contract changes. Classification: external-api-change, security-sensitive-change.

Reviewed upstream Gorilla14commits and compression1.20.5 changes against all callers. Existing zstd round-trip/hash/bounds/archive/secret-exclusion and WebSocket tests exercise actual behavior. Hashes validate actual compressed bytes, not cross-version deterministic output. Go1.26.11 baseline retained.

## Checklist
- [x] Reconcile original head, complete checks/reviews/comments/threads/files, ownership and duplicates; associate original PR.
- [x] Inspect actual failed job and official advisory; select first fixed commit and supported transitives.
- [x] go test -race ./...: 31 packages, 4338 tests/subtests pass, 31 skipped; no failures.
- [x] go vet ./...; go build ./...; go mod verify pass.
- [x] Repository-pinned govulncheck: No vulnerabilities found.
- [x] Local Go/constitution/completion and independent security review PASS; no findings.
- [ ] Current-head CI, best-effort CodeRabbit request, all review findings addressed.
- [ ] After existing header/WAF setup and #3014 runner proof, normal main merge, full checks, staging under lease, real VM compression/upload and WebSocket evidence, cleanup.
- [ ] Merge with all applicable gates green; monitor actual rollout and basic read-only production health/version.

## Blocker and release conditions
Existing setup ask:01M86G5HPXQFHMAVENVXWPBACV and task01M84XXMBA4P3C39RR9EDKG9NV/#3014 own runner Cloudflare challenge. No duplicate fix, ask, lease overwrite or unchanged redeploy. Runtime staging is mandatory; tooling exception does not apply. Release this prerequisite before SDK2997, then inherit through main normally. Preserve original PR branch/history.

## 27 November integration checkpoint

Normal main merge `52a10661633a02883c7c8e9f5b6878c71efa8be4` inherits merged installation-key work #3019 (`2ca8bf2c038081f7dcd889f83fb082dc71b3b4b9`). Entire VM-agent tree is identical to the prior reviewed candidate; diff against main remains go.mod/go.sum plus this task. Independent Go/completion integration review PASS, no findings. Fresh mod verify/build/vet PASS and repository-pinned govulncheck reports No vulnerabilities found. Focused race verification is in progress; prior full-race evidence remains applicable to the unchanged tree. New-head CI must pass after push. CodeRabbit's previous failed request/skip is final for this unchanged implementation.

The key prerequisite is cleared, but #3014 runner-header proof and the canonical setup item's Rule2 VM ready/heartbeat proof remain outstanding. Do not deploy or allocate another VM into the unchanged challenge. Retain mandatory leased runtime staging, cleanup and sequential actual rollout gates. No task completion or merge readiness claimed.
