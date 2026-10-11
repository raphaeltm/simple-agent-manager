# Owner retained session snapshot export (draft only)

Task: 01M4NYZ5K200GVW23JGBGA4T13. Branch: sam/implement-narrow-owner-authenticated-ga4t13.

## Problem and scope

The workspace callback artifact download requires the original runtime identity. A human owner needs a supported read-only way to download a retained manifest and exact WIP even when the session is stopped/archived and its workspace is gone. Separate DRAFT PR ONLY: no merge or production rollout. Original A recovery remains unapproved; production WIP contents have not been independently verified.

## Research

- Existing callback routes: apps/api/src/routes/workspaces/session-snapshots.ts; preserve byte-for-byte.
- D1 session_snapshots owns user/project/session, canonical snapshot generation, manifest JSON/hash/keys/expiry; workspace reference can become NULL on deletion.
- ProjectData getSession resolves canonical archived session as well as active session; createdByUserId establishes actual session creator.
- BetterAuth requireAuth/requireApproved plus active project membership are necessary but membership alone is insufficient.
- R2 get onlyIf.etagMatches pins a verified object; crypto.DigestStream verifies hashes without retaining WIP in memory. Existing JSON/binary/idle-transfer limits reused. No migrations/config additions expected.
- Existing task searches `owner snapshot export`, `retained manifest` and GitHub open/all PR searches found no duplicate exact implementation. Phase1 #2304 coordination requested before overlap.
- Observed Codex turn_context.model=gpt-6.1-sol; ACP Codex runtime observed; Sol catalog01KSSMJCG4EE1XS153GNZX5B09.

## Implementation checklist

- [x] Real Worker route/DO/D1/R2 tests first: owner success, stopped/archive/missing workspace, foreign/missing nondisclosure, same-project different owner, snapshot/session mismatch, expired/deleted, capture/expiry/object races, missing/corrupt artifacts, headers/auth/errors.
- [x] Separate browser-auth route for manifest/WIP only, canonical identity/generation/integrity and final authorization recheck, safe errors and private no-store attachment.
- [x] Existing session UI owner-only phone-usable download control with errors and no wake/mutations.
- [x] API contract/reference and end-user docs synchronized; existing limits documented.
- [x] Mobile+desktop Playwright interaction/screenshots with synthetic stress data; inspect for overflow/clipping/secrets.
- [ ] Lint/typecheck/tests/build and required CI.
- [ ] Independent security review, fresh adversarial review, Cloudflare/UI/completion/domain review; all findings resolved.
- [ ] Bounded staging plan: synthetic artifacts only, zero VMs/no added spend; coordinator grant BEFORE shared deployment/resources; restore prior stage.
- [ ] New draft PR initially; exact-head gates/evidence reported to coordinator/channel; no merge/production deploy.

## Acceptance criteria

Only an authenticated approved actual owner with original project access and creator identity can export the retained canonical manifest/WIP. No HOME, keys, public URLs, agent shortcut or admin bypass. No live runtime dependency or original lifecycle mutation. Exact WIP bytes retained unchanged; integrity and race failures never return unverified bytes. Errors do not disclose foreign/missing resources or private content. UI works on phone. No production artifacts downloaded or ingested/logged/published.

## References

Repository /do skill; API/web AGENTS.md; API/env references; scoped callback-auth/boundary validation/UI visual rules; security-auditor/cloudflare-specialist/ui-ux-specialist/task-completion-validator skills. Cloudflare R2 Workers API and Web Crypto DigestStream documentation.

## Gate state

Draft PR: https://github.com/raphaeltm/simple-agent-manager/pull/2308 (initial API87eaa43e7; final head recorded in PR body). Never ready/merge/production deploy. Task stays active while staging authorization is pending.

- Full root lint/typecheck/tests/build PASS; formatting ratchet and file-size/AST checks PASS (baseline warnings). API12010/web4045 tests plus packages passed; real Worker boundary37/37 PASS. Final web lint/typecheck/component checks PASS after UI edits.
- Independent security and fresh adversarial source PASS; Cloudflare/test/docs/Principle XI PASS. Findings fixed: shared DO helper raw provider logging + implicit metadata write avoided; D1/DO/R2 deadlines and unused stream cancellation bounded; native browser attachment avoids large phone Blob.
- Full real session-page Playwright9/9 PASS at375x667/320x667/1280x800: exact seven synthetic bytes via actual local HTTP attachment server (no redirects), safe404/retry, other-owner hiding, long/special/empty fixtures,35messages+35sessions, keyboard control. Final exact-candidate browser rerun15/15 PASS including56px summary assertion and390px/tablet sizes. Screenshots tasks/evidence/2026-10-11-owner-retained-export inspected by primary and UI reviewer; synthetic only, no secrets/content requiring redaction.
- UI/docs/completion review PASS for implemented scope with CI/staging/PR gates explicitly pending. API references describe authenticated HEAD and native GET; a capture/expiry change after HEAD can make final native GET fail safely outside the component error UI. Physical iOS Safari untested.
- No staging grant, deployment or shared resources. Bounded zero-VM plan prepared: capture current stage revisions/restore target, one <=1KiB synthetic fixture, normal designated smoke-owner flow, no VM/Container/Instant/pool/credentials/global-auth/config/migrations, clean own fixture, restore priorstage under coordinator sequencing. No production artifacts accessed; original A WIP remains unverified and recovery unapproved.
- Coordinator/Phase1 queued exact path/interface messages and channel claims before additive index/sessionUI overlap; Phase1 current diff had no overlap. Existing snapshot callback/routes/services and original branches/PRs untouched.
