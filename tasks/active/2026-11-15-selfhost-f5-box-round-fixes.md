# F5: self-host defects from box rounds R15, R16 and R17

Task 01M7GA4J5DE2Q9QPK7XNYYM93H. Base branch `sam/selfhost-pass-2` @ a9da5175913c41e54af92554d05f7ec705250a49.
Output branch `sam/task-f5-fix-self-yym93h`. One draft PR against `sam/selfhost-pass-2`; the coordinator merges.

## Problem

Box rounds R15 (install guide), R16 (orphan sweep) and R17 (hosted git move, main merge) on the
self-host test box found:

- D1 (R17 B5): owner security alerts never send on a box. `deliverSecurityAlert` asked only for
  Cloudflare's `AGENT_EMAIL` binding (`agentEmailSenderFor`), while email sign-in sends through
  SMTP. Every alert logged `security_alert.no_sender`.
- G3 (R15): `POST /api/auth/workload-identity-login` answered 404 for about 20 s after
  `pnpm selfhost:deploy` printed "deployed".
- G5 (R15): teardown kept `sam-allow-agent` / `sam-allow-app-routes` because VMs SAM did not
  create (another agent's fixtures, labelled but without network tags) were counted as users.
- G4 (R15): the `deploy --init` key refusal ends "Then run the same command again.", which reads
  as "run the bootstrap again"; it means `deploy --init`, on the box.
- Sealed values (R16): no supported way to remove a sealed value; deleting the line from
  `.state/secrets.env` leaves it in the newest sealed bundle (bundles merge).
- D4 (R17): GitLab OAuth scope string repeats `read_user`.
- Wording: the upgrade backup's live pre-copy 404 on a celld node-lease object reads like a defect.

Out of scope (tracked elsewhere): Admin Settings 503 on one invalid stored value
(idea 01M7GA366849928YDY33ZW26Y2), pinned task on a not-agent-ready node
(idea 01M7EPADE2F97EHG504BD33F9H), hourly telemetry upsert for a deleted project.

## Research findings

- `apps/api/src/services/email-sign-in.ts` `deliverSignInCode` built the transport inline
  (`emailTransportKind` + `getAgentEmailLimits` + `systemEmailTransportFor`).
- `apps/api/src/services/security-alerts.ts` `deliverSecurityAlert` used `agentEmailSenderFor`.
- Callers of `scheduleSecurityAlert`: admin-settings PATCH, admin-platform-config (save/clear),
  setup completion, BetterAuth account-create hook.
- Agent sign-in steps aside (falls through to BetterAuth 404) when `AGENT_SIGN_IN_TRUST` is not
  resolved (`routes/agent-sign-in.ts`). `waitForHealth` (`scripts/selfhost/deploy-steps.ts`)
  returns on the first 200 from `/health`, which the previous Worker version also answers.

## Implementation checklist

- [x] D1: shared `resolveSystemEmailTransport` (`apps/api/src/services/agent-email/system-email.ts`);
      `deliverSignInCode` and `deliverSecurityAlert` both use it; Cloudflare unchanged
      (binding wins, `security@agents.<BASE_DOMAIN>`); no transport keeps `security_alert.no_sender`.
- [x] D1 tests through the admin-settings route (save + clear) and the account-link hook body,
      real SMTP server; Cloudflare binding control; no-transport control. Verified red pre-fix
      (4 SMTP cases red, controls green).
- [x] D1 docs: self-hosting.mdx security alerts, deploy/selfhost/README.md Email sign-in.
- [x] G3: cause from celld 0.6.3 source/docs (nodes poll `deploy/current.json` every 30 s,
      `POST /reload` adopts at once; `selfhost:deploy` never called it, so `/health` passed on the
      previous version). Fix: `verifyNewVersionServes` (`scripts/selfhost/celld-adopt.ts`) adopts,
      then health, then the agent sign-in route when `AGENT_SIGN_IN_TRUST` is set; 422 and silence
      fail the deploy. Adopt helpers moved from `secrets-box-deps.ts`. Box measurement pending.
- [x] G5: teardown advice reads the rule's network/target tags and all project VMs
      (`firewallUsage`, `teardown-gcp.ts`); rules still never deleted. CLI test + branch tests.
- [x] G4: refusal says "Then run `pnpm selfhost:deploy --init` again on this box, in the SAM
      checkout." (`switch --to auto` names itself); GCE VM name/zone filled from metadata.
- [x] Sealed values: `pnpm selfhost:deploy --unset NAME` (`assertUnsettable`, `key-service.ts`);
      dry run only checks names (security review); README section.
- [x] D4: `disableDefaultScope: true` (`gitlab-login-provider.ts`); authorize-URL test.
- [x] Backup wording: `backup-lib.ts` log line + README.
- [x] Reviews: security-auditor (1 MEDIUM fixed), cloudflare-specialist (lint + 2 LOW fixed),
      test-engineer (HIGH: deploy wiring and dry-run; addressed with `verifyNewVersionServes`
      ordering tests, dry-run deploy test, contract fake, branch tests, account-link via the real
      better-auth hook), task-completion-validator (WARN: stale checklist, fixed here).
- [x] CI dispatched by hand: run 43769639876 green on d5f9991c8; run 43771933518 on 4809b097b (Sonar refactor). SonarCloud quality gate OK; issues in touched code fixed in 4809b097b.
- [x] Box verification per item (PR #2764 body, Staging Verification Evidence). Box left on 4809b097b, bundle e46cd268, health 200.

## Acceptance criteria

- [x] On the box, saving and clearing an integration delivers an alert mail to the collector, no
      `security_alert.no_sender`.
- [x] Cloudflare behaviour identical except the GitLab authorize URL (D4, same granted scopes; coordinator told) (binding path tests); wrangler.toml byte-identical to main;
      selfhost-only-modules guard passes.
- [x] G3 cause identified with evidence; deploy health waits for the route when trust is set.
- [x] Teardown never deletes or changes a resource SAM did not create.
- [x] Refusal message names `pnpm selfhost:deploy --init` and where to run it.
- [x] A sealed value can be removed through a supported path.
- [x] GitLab scope string has each scope once.

## Notes

- Shared files touched (apps/api, packages): `apps/api/src/services/agent-email/system-email.ts`
  (new), `apps/api/src/services/security-alerts.ts`, `apps/api/src/services/email-sign-in.ts`,
  `packages/agent-email/src/provider.ts` (comment), `apps/api/src/services/gitlab-login-provider.ts`
  (the only Cloudflare-visible change: the GitLab authorize URL no longer repeats `read_user`).
- Untested by unit tests: the single call of `verifyNewVersionServes` in `deploy.ts` (the deploy
  needs a real build and celld); covered on the box.
- Workspace was recreated once after a provider usage-limit pause (22:17 UTC); Git was intact.
