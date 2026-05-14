# Debug Package Cleanup Fixes

## Problem

Recent production debug packages surfaced several issues that are either misleading during recovery or under-instrumented when failures happen:

- Host credential-helper setup reports a failed provisioning step when a retry sees `/tmp/git-credential-sam-<workspace>` already present.
- Cloud-init emits `cloud-config failed schema validation`, which makes real boot failures harder to spot.
- Early boot logs can complain about missing IPv6 iptables persistence files before SAM's firewall script writes rules.
- VM-agent ACP heartbeat failures only log status code or timeout; production evidence showed a `500` caused by a Durable Object code update/reset, but the VM-agent log alone was not enough to identify that.

## Research Findings

- `packages/vm-agent/internal/bootstrap/bootstrap.go` writes host credential helpers with `O_CREATE|O_EXCL` for TOCTOU protection, then bind-mounts the file into the devcontainer.
- Debug packages showed retries recovered, but boot events recorded `git_credential_helper` as failed because the helper path already existed.
- `packages/cloud-init/src/template.ts` owns firewall setup and writes `/etc/iptables/rules.v4`/`rules.v6` after provisioning steps.
- Existing cloud-init tests in `packages/cloud-init/tests/generate.test.ts` already parse rendered YAML and assert firewall snippets.
- `packages/vm-agent/internal/server/acp_heartbeat.go` logs heartbeat non-success status without body/context and uses the default control-plane HTTP timeout.
- Production observability D1 showed the heartbeat `500` coincided with `Durable Object reset because its code was updated`, and both nodes later returned to healthy heartbeat state.

## Relevant References

- `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`: infrastructure changes require real VM verification and cloud-init template validation.
- `docs/notes/2026-03-06-heartbeat-token-expiry-postmortem.md`: heartbeat failures must be self-healing and diagnosable.
- `docs/notes/2026-05-12-task-callback-middleware-leak-postmortem.md`: callback routes need explicit auth/routing coverage.
- `docs/notes/2026-05-04-devcontainer-gitconfig-lock-postmortem.md`: credential setup needs retry/concurrency tolerance.

## Implementation Checklist

- [ ] Make host credential-helper creation retry-safe: safely reuse or replace existing regular helper files for the same workspace, while still failing suspicious paths.
- [ ] Add tests for credential-helper retry behavior and suspicious existing files.
- [ ] Clean up cloud-init schema/netfilter warnings by ensuring valid rendered cloud-init and valid early IPv6 rules persistence state.
- [ ] Add/update cloud-init tests covering schema-relevant structure and IPv6 rules file initialization.
- [ ] Improve VM-agent ACP heartbeat diagnostics for non-2xx responses by logging bounded response body and route context.
- [ ] Treat the specific Durable Object code-update reset message as a transient heartbeat condition with less alarming logging.
- [ ] Add tests for ACP heartbeat non-2xx body logging/transient classification.
- [ ] Run focused package tests, then full quality checks where feasible.

## Acceptance Criteria

- Retried workspace bootstrap no longer records host credential-helper `file exists` as a failed step when the existing file is a safe regular helper.
- Cloud-init output no longer emits avoidable schema or missing IPv6 persistence warnings for the generated SAM template.
- ACP heartbeat logs include enough information to identify API/DO failures without needing a separate production observability query.
- DO code-update reset responses are classified as transient deploy noise.
- Tests cover the changed VM-agent and cloud-init behavior.
