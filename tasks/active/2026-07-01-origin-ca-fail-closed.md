# Origin CA Bootstrap Fail Closed

## Problem
PR #1413 added a cloud-init fallback that starts the VM agent without TLS when per-node Origin CA bootstrap fails. The fallback removes `TLS_CERT_PATH` / `TLS_KEY_PATH` from the systemd unit and switches `VM_AGENT_PORT` from `8443` to plaintext `8080`.

This violates the project security policy: security-sensitive setup failures must fail closed visibly rather than starting an insecure degraded service. It is also functionally mismatched with the control plane, which still expects VM agents at `https://<node>.vm.<domain>:8443`.

## Research Findings
- **Fallback location**: `packages/cloud-init/src/template.ts` logs `falling back to plaintext mode`, removes TLS env vars, and rewrites `VM_AGENT_PORT=8443` to `VM_AGENT_PORT=8080`.
- **Control plane expectation**: `apps/api/src/services/node-agent.ts` builds node-agent URLs from `VM_AGENT_PROTOCOL` default `https` and `VM_AGENT_PORT` default `8443`.
- **Worker config**: `apps/api/wrangler.toml` defaults `VM_AGENT_PROTOCOL=https` and `VM_AGENT_PORT=8443`.
- **Observability gap**: There is no `fallback_used` D1 column or centralized metric; the fallback marker is VM-local cloud-init log output.
- **Runtime evidence checked before implementation**: Staging and production observability D1 had zero `Origin CA` / `node_origin_ca_certificate.failed` records for 2026-07-01, and the post-deploy production node tested over direct IP responded on HTTPS `8443` and refused HTTP `8080`.

## Implementation Checklist
- [x] **cloud-init template**: Remove the plaintext fallback branch.
- [x] **cloud-init template**: On key generation, CSR generation, or Origin CA request failure, remove partial TLS files and exit non-zero before `systemctl start vm-agent`.
- [x] **cloud-init template**: Keep TLS env vars and `VM_AGENT_PORT={{ vm_agent_port }}` untouched on failure.
- [x] **cloud-init tests**: Assert generated cloud-init no longer contains plaintext fallback markers, TLS env deletion, or port rewrite to `8080`.
- [x] **cloud-init tests**: Assert Origin CA failure exits non-zero and preserves the HTTPS/TLS service contract.
- [x] **validation**: Run targeted cloud-init tests.
- [x] **validation**: Run full quality suite before PR.
- [x] **staging**: Deploy branch to staging, provision a real VM, verify heartbeat and TLS/HTTPS behavior, then clean up.

## Acceptance Criteria
- [x] Generated cloud-init never starts vm-agent in plaintext fallback mode after Origin CA bootstrap failure.
- [x] Origin CA bootstrap failures fail provisioning visibly before `vm-agent` starts.
- [x] VM-agent systemd unit remains configured for the expected TLS port/protocol contract.
- [x] Tests cover the removal of plaintext fallback behavior.
- [x] Staging infrastructure verification provisions a real VM and confirms heartbeat/TLS behavior.
- [ ] PR is created and merged only after CI is green.

## Validation
- **Targeted local**: `pnpm --filter @simple-agent-manager/cloud-init test` passed (175 tests).
- **Targeted local**: `pnpm --filter @simple-agent-manager/cloud-init typecheck && pnpm --filter @simple-agent-manager/cloud-init build` passed.
- **Full local**: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passed.
- **Staging deploy**: GitHub Actions run `28536921575` deployed `sam/origin-ca-fail-closed` to staging; smoke tests passed.
- **Staging browser auth**: Playwright token-login loaded `/dashboard`, `/projects`, and `/settings/cloud-provider` on `https://app.sammy.party` without unexpected console errors.
- **Staging VM**: Created workspace `01KWFDR7T14DD2ECBTGCXBQSXW` on node `01KWFDR7BVTWR6EN7C82E818WH`; workspace reached `running`, node reached `running/healthy`, and fresh heartbeats were observed.
- **Staging VM security contract**: Workspace creation exercised the control-plane node-agent path that defaults to `https://<node>.vm.sammy.party:8443`; `http://<node>.vm.sammy.party:8080/health` did not serve vm-agent health (`521`, not `200`).
- **Staging cleanup**: Deleted workspace `01KWFDR7T14DD2ECBTGCXBQSXW` and node `01KWFDR7BVTWR6EN7C82E818WH`; a follow-up node fetch returned `404`.

## References
- Previous session: `48e407a7-800d-4c2f-93ab-5b6fad97c0fc`
- PR #1413: `fix: per-node Origin CA certificates with graceful fallback`
- Policy: Fail closed instead of insecure fallback
- `.claude/rules/32-cf-api-debugging.md`
- `.codex/prompts/do.md` Phase 6b infrastructure verification
