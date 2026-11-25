# Self-host hardening: umask-independent upgrade, spending-limit failure label

## Problem
1. (idea 01M89H1MQHJH432BFT2N43GHJJ) `pnpm selfhost:upgrade` under `umask 077` rewrote 111 tracked
   files as 0600 on `git checkout --detach`; the non-root key agent got EACCES, and the automatic
   rollback failed the same way. Self-hosting only.
2. (idea 01M89JXTFHW4W3PQ65GTED6D0K) A SAM AI proxy spending-limit 429 is reported by the VM agent as
   `provider_overloaded`, so the chat failure card says "Provider overloaded · Recoverable". Settings >
   Usage says "AI Gateway traffic only" on gateway-less installs, and its selected period button is
   invisible (`bg-accent-emphasis` is not a defined token). Shared with hosted SAM.

## Research
- Checkouts: `upgrade-lib.ts` (`applyUpgrade`, `recoverUpgrade`, `rollbackFailedUpgrade`) and
  `upgrade-rollback.ts` (operator ref restore). Real runner `runCommand` spawns with cwd REPO_ROOT.
- Entry scripts: upgrade.ts, deploy.ts, rebuild.ts, restore.ts (rollback is `upgrade.ts --rollback-from`).
- Private writers already pass explicit modes: `secret-files.ts` (fchmod 0600, dir 0700),
  `backup-encryption.ts` (0600/0700), `backup-destination.ts` (0700), upgrade-lib stateDir (0700).
- Key agent image copies `deploy/selfhost/key-agent/*.ts` and runs as `SAM_KEY_AGENT_UID`.
- VM agent: `acp.ClassifyPromptError` maps claude `errorKind: rate_limit` and `api error: 429` text to
  `provider_overloaded`; task callback sends the bare code (`taskCallbackErrorMessage`). UI classifies
  via `packages/shared/src/failure-classification.ts`.
- Proxy messages: `monthlyCostCapMessage` (packages/ai-proxy), daily token budget in
  `apps/api/src/routes/ai-proxy-admission.ts`.

## Checklist
- [x] `operator-files.ts`: `useOperatorUmask()` (0o022) + `checkoutWithTrackedModes()` re-applying git modes
- [x] Call umask at entry of upgrade/deploy/rebuild/restore; use the checkout helper at every checkout
- [x] Tests: real git checkout under umask 077 (upgrade + rollback paths) leaves key-agent inputs world-readable; private writers stay 0600/0700 under umask 000/022; guard deletion goes red
- [x] README note updated
- [x] VM agent: `sam_ai_usage_limit_reached` reason when the rate-limit error carries SAM's proxy limit text; real overload unchanged (tests)
- [x] Shared classifier: structural rule "SAM AI usage limit reached", not retryable; provider-overload unchanged (tests)
- [x] Usage page: subtitle/empty-state wording; selected button + bars use defined `bg-accent`
- [x] Playwright audit 375/1280
- [ ] Live (pending): self-host live suite + upgrade/rollback live tests on celld; box end-to-end of the banner

## Acceptance
- Upgrade and rollback under umask 077 leave tracked files at git modes; key agent starts.
- `.state/*`, backups, keys remain 0600/0700.
- Spending-limit refusal shows the spending-limit label; real provider overloads still show "Provider overloaded".

## Review notes
- Local reviewers: task-completion-validator, go-specialist, security-auditor, ui-ux-specialist. No CRITICAL/HIGH.
  Addressed: directory modes repaired too; chmod never follows a symlinked parent out of the repo and
  never throws; entry points proven by spawning them under umask 077; real-git manual rollback test;
  legacy adoption uses an explicit checkout helper plus an enumeration test; Go detector requires
  typed 429 evidence (rate_limit kind, Codex turn error, or `API Error: 429` prefix) and a standalone 429.
- Guard deletion: mode repair off -> 7 mode tests red; restore.ts umask call removed -> its entry test red;
  Go ClassifyPromptError check off -> 6 cases red; ClassifyProviderLimit guard off -> parking test red;
  FailureCard gate off -> usage-limit card test red.
- Found while testing (pre-existing, not changed): `tsx script.ts --env-file X` also hands `--env-file` to
  node, which loads X into process.env (and fails if X is missing).
