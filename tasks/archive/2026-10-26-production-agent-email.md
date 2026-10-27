# Production agent email with admin DNS consent

## Problem

Production deployment skips email preparation. Admin cannot enable email despite the deployment token carrying email permissions. User authorized implementation through production; DNS changes must be previewed and confirmed in Admin Integrations, with no new GitHub variables.

## Research

- deploy-reusable.yml defaults agent_email false; only staging forwards the option.
- configure-agent-email.ts prepares sending DNS and a marker consumed by sync-wrangler-config.ts.
- API agent-email/setup.ts plans routing, uses a durable D1 lease and consent digest, but refuses existing root MX/SPF on first use.
- Cloudflare domain docs recommend merging SPF; routing DNS enable with a subdomain name preserves root MX but can add root SPF/DKIM. Must verify actual API behavior, preserve existing sender authorization, and avoid duplicate SPF.
- Existing inbound.ts documents an unresolved sender-authentication production gate. Investigate current provider behavior before release; do not silently remove protection.
- Existing admin component displays additions/removals and binds consent to plan token.

## Checklist

- [x] Verify Cloudflare DNS semantics and production authentication gate.
- [x] Automatically prepare required deployment bindings in staging and production.
- [x] Plan and apply email DNS changes only with admin consent; preserve root MX and SPF authorization, fail closed on drift and conflicts.
- [x] Support clean installs, upgrades, retries and existing staging setup records.
- [x] Update admin copy and public docs; mobile/desktop visual proof.
- [x] Add meaningful setup, consent, deployment and safety regression tests.
- [x] Run relevant quality checks and local specialist reviews.
- [x] Verify staging end to end and clean up owned resources.
- [ ] PR, CI, CodeRabbit request/wait, merge, production deploy and basic smoke.

## Acceptance

Admin can enable production email without GitHub variable or Cloudflare dashboard steps, sees proposed DNS changes before applying, and existing mail remains intact. Email remains off until setup succeeds. Fresh install and upgrade paths tested. No known production safety gate bypassed.

## References

https://developers.cloudflare.com/email-service/configuration/domains/
https://developers.cloudflare.com/email-service/configuration/subdomains/
https://github.com/cloudflare/workerd/issues/6740

## Implementation evidence

- Local security/Cloudflare, completion/documentation/constitution/test, and UI specialist reviews passed. 70 focused API cases and 21 deployment cases passed. Full lint/typecheck/test/build passed (13/19/21/9 tasks); API 13,898 tests passed and 2 skipped; web 4,762 passed. Formatting and file-size ratchets passed.
- Eight mobile/desktop Playwright cases passed; final consent/refusal fixtures rerun (four passes). Screenshots reviewed by parent and UI specialist: approval reachable and records wrap on mobile.
- Public DoH verification of Google plus Cloudflare SPF fits the recursive lookup limit.
- Sender-auth concern resolved by explicit prior user decision documented in the prototype archive (2026-10-23); stale gate comment corrected. No new authentication bypass.
- Optional staging provider audit verifies combined SPF preservation on the already-enabled zone and restores the original policy even after an ambiguous failed write. Local boundary scenarios passed: success, PATCH timeout after apply, routing failure, and wrong-zone refusal. Fresh-zone behavior remains covered by simulated provider tests; live staging cannot reproduce a fresh zone.

## Staging evidence (2026-10-27)

- Deployment [40423217134](https://github.com/raphaeltm/simple-agent-manager/actions/runs/40423217134) passed including smoke tests and provider DNS audit. Candidate e456b3f2ebdf10284706359d95bb97f496d9f5bc at 100%, Worker version a156b83d-6871-408e-ab20-b012f5e35cbe. Email binding present; prior disabled staging became enabled automatically using its saved setup.
- Audit at 00:11:50 UTC preserved combined Google/Cloudflare SPF and root MX, then restored original SPF. This is repeated enable on the existing zone, not fresh-zone evidence.
- Playwright created one email trigger through the UI and sent one admin loopback. Trigger 01M5XB0V8R8XRP42VCKCK9A6VN; execution/task 01M5XB10ZM6A3RNRNSTR3DZ05F. Sent 00:09:09.744, reply received 00:18:46.892, task completed 00:18:54.262. Received From matched the trigger address, In-Reply-To matched provider message ID, Auto-Submitted was auto-replied.
- One cx23 VM provisioned in fsn1; node 01M5XB1HA3J84YKNMTS0M7GCMQ heartbeat observed 00:11:39.906. Workspace 01M5XB88H68MYWNDKNFQGBED8H reached running; browser loaded its live agent transcript, showing the successful reply and completion. Its HTTPS endpoint responded with the expected unauthenticated 401.
- Dashboard, projects and settings navigation passed. Desktop and fresh mobile admin On controls passed with no page errors. A repeated-navigation browser run stalled at the app-wide loader; fresh sessions passed. The staging user's optional onboarding overlay was dismissed before final mobile screenshot review. No personal cloud credential was added; effective platform credential provisioned the VM.
- Mock consent screenshots permanently stored on evidence branch sam/email-prod-evidence (c776754e378576ceb3ede52ac1140fd1c54bf45e) and project Library /engineering/email-production-2026-10-26.

## Release tracking

Implementation and staging are complete; PR/CI/CodeRabbit/merge/production evidence is tracked in the PR and local .do-state.md. Production activation remains the admin's explicit DNS consent action.

- Cleanup confirmed: trigger, workspace and node DELETE each returned 200; workspace deletionStatus confirmed. Node list excludes the owned node and preserves all four preexisting nodes. Final task-completion specialist review PASS for implementation/staging.
