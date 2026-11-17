# Re-review expired historical PEM-parser Gitleaks group

## Problem and preflight

Secret Scan fails closed because the August 19 code-identifier group expired November 17, even when no finding matches it. Security-sensitive config-only maintenance; no scanner/runtime, scheduling, concurrency, resource, permissions or security behavior change. Public interfaces and documentation unchanged.

## Research

- Reconciled main cbe12a472, 21 open PRs, 194 associations across four pages, active agents and Gitleaks/secret-baseline task searches. No competing maintenance owner. Prior #2554 is complete; existing idea 01M77E3ZGAKRWXECQ5C7P5TKM1 tracks expiry.
- Group 5 has three exact digests introduced by e079597ab21ce94d5962a04e8c97bf6a320783b7. Checksum-verified Gitleaks 8.30.1 scanning that historical file reproduces all three, at apps/api/src/services/github-app.ts lines 204/211/222.
- Independently inspected entire matched spans (108/140/1126 bytes): PEM delimiter comments, conditional checks, stripping and ASN.1 wrapping/encoding code; no embedded private key body. Current converter lives in packages/repo-hosting/src/github-app-tokens.ts under a separately reviewed group.
- Retain all three historical digests for PR-range history; absence from current tree is insufficient to delete them. No other group needs renewal for this task.
- Protected main rejects direct task-record pushes (prior #2554 evidence); task record travels through the same PR. Clean nested worktree avoids pre-existing local .codex/config.toml changes.

## Implementation checklist

- [x] Reconcile ownership and read routed rules, scanner policy, prior maintenance and constitution.
- [x] Reproduce all three exact historical digests and inspect full matched bytes safely.
- [x] Renew only selected group's actual UTC review time, bounded 30-day expiry and specific historical rationale; preserve digests and all other groups.
- [x] Run real current-tree and PR-range scans, historical range proof, existing fail-closed tests and fresh private-key detection controls.
- [x] Complete independent security, constitution and task-completion reviews; address findings.
- [x] Record config-only staging exemption and validation in PR.

## Acceptance criteria

Only groups[5] (sixth group) metadata changes alongside this task record. Three exact verified non-secret digests retained, zero added or removed; no other baseline entries changed. Real scanner modes pass while unreviewed private-key bytes and expired/malformed/replaced findings fail closed. Reviews and current-head CI pass before normal merge. Local state/raw evidence never committed.

## Release work (pending normal PR gates)

- [ ] Request/wait for CodeRabbit, pass CI, merge.
- [ ] Verify shared main Secret Scan restored; notify parent and #2824 owner 01M7JPQE1CZVR7AWQHJ4Z4JXGP; update existing idea.

## Validation and post-mortem

Pre-change real current-tree scan reproduced exact expiry error. This is expected expiration enforcement, not evidence of a new leak. Review dates require deliberate human-authorized maintenance; no automatic extension, ignore, scanner redesign or new standing rule is needed. Staging is exempt for config-only metadata per /do and explicit task scope.

- Real current-tree: 43 reviewed/0 new. Candidate PR-range: 0/0 new. Isolated historical-source replay through the actual PR-range runner: 3 reviewed/0 new. Fresh generated private-key detection controls in isolated repositories: both current-tree and PR-range fail closed, generic output only; ephemeral key/repo deleted.
- Existing policy and CI-quality tests: 2 files, 35 tests passed, no skips; targeted Prettier and diff whitespace checks pass.
- Independent security-auditor and constitution-validator: PASS, no findings; exact digest tuple and complete historical spans independently verified.

- Full quality-scripts suite: 74 files, 1327 tests collected; 1324 passed and 3 setup failures because clean worktree lacked the shared-package dependency link. Added local dependency symlink only, then affected ci-test-shards.test.ts rerun: 13/13 passed. Same 13/13 also passed in original checkout. No test/code change required.
- Independent completion review PASS for implementation archive handoff, with release checklist explicitly pending; all local reviews complete. Archive does not certify overall release.
- PR: https://github.com/raphaeltm/simple-agent-manager/pull/2825. Normal current-head CI, CodeRabbit request/wait, merge, main gate proof and final notifications remain release gates.
