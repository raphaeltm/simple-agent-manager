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
- [ ] Existing session UI owner-only phone-usable download control with errors and no wake/mutations.
- [x] API contract/reference and end-user docs synchronized; existing limits documented.
- [ ] Mobile+desktop Playwright interaction/screenshots with synthetic stress data; inspect for overflow/clipping/secrets.
- [ ] Lint/typecheck/tests/build and required CI.
- [ ] Independent security review, fresh adversarial review, Cloudflare/UI/completion/domain review; all findings resolved.
- [ ] Bounded staging plan: synthetic artifacts only, zero VMs/no added spend; coordinator grant BEFORE shared deployment/resources; restore prior stage.
- [ ] New draft PR initially; exact-head gates/evidence reported to coordinator/channel; no merge/production deploy.

## Acceptance criteria

Only an authenticated approved actual owner with original project access and creator identity can export the retained canonical manifest/WIP. No HOME, keys, public URLs, agent shortcut or admin bypass. No live runtime dependency or original lifecycle mutation. Exact WIP bytes retained unchanged; integrity and race failures never return unverified bytes. Errors do not disclose foreign/missing resources or private content. UI works on phone. No production artifacts downloaded or ingested/logged/published.

## References

Repository /do skill; API/web AGENTS.md; API/env references; scoped callback-auth/boundary validation/UI visual rules; security-auditor/cloudflare-specialist/ui-ux-specialist/task-completion-validator skills. Cloudflare R2 Workers API and Web Crypto DigestStream documentation.

## Gate state

Implementation mounted; real Worker/DO/D1/R2 suite 37/37 PASS including real BetterAuth cookie and HEAD preflight. Owner download uses authenticated HEAD then native GET attachment to avoid phone Blob buffering. Callback routes/services remain unchanged. Independent security mounted review PASS; fresh adversarial final browser proof pending; Cloudflare/test/docs/Principle XI review PASS. Full typecheck PASS (www reports baseline template diagnostics). Lint import sorting fixed, rerun pending. Root tests pending; parallel root build collided with test-triggered www build, needs serial rerun. Local full session-page desktop/mobile audit pending. No staging grant or deployment; bounded zero-VM synthetic plan prepared. Coordinator and Phase1 received queued interface/path messages and channel claims before additive index/sessionUI edits; Phase1 current diff had no overlap. Never merge/ready/production rollout; original A artifacts uninspected and recovery unapproved.
