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
- [ ] G3: measure on the box, read code, fix if small (deploy health check waits for the route).
- [ ] G5: teardown firewall-rule users exclude VMs SAM did not create; never touch non-owned.
- [ ] G4: refusal message names the command and where to run it.
- [ ] Sealed values: supported removal (command/flag) or documented procedure.
- [ ] D4: GitLab scope de-duplicated, test.
- [ ] Backup wording: pre-copy 404 on node lease says it is expected.
- [ ] Box verification per item.

## Acceptance criteria

- [ ] On the box, saving and clearing an integration delivers an alert mail to the collector, no
      `security_alert.no_sender`.
- [ ] Cloudflare behaviour identical (binding path tests); wrangler.toml byte-identical to main;
      selfhost-only-modules guard passes.
- [ ] G3 cause identified with evidence; deploy health waits for the route when trust is set.
- [ ] Teardown never deletes or changes a resource SAM did not create.
- [ ] Refusal message names `pnpm selfhost:deploy --init` and where to run it.
- [ ] A sealed value can be removed through a supported path.
- [ ] GitLab scope string has each scope once.

## Notes

- D1 shared files touched: `apps/api/src/services/security-alerts.ts`,
  `apps/api/src/services/email-sign-in.ts`, new `apps/api/src/services/agent-email/system-email.ts`,
  comment in `packages/agent-email/src/provider.ts`.
