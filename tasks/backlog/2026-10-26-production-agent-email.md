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
- [ ] Verify Cloudflare DNS semantics and production authentication gate.
- [ ] Automatically prepare required deployment bindings in staging and production.
- [ ] Plan and apply email DNS changes only with admin consent; preserve root MX and SPF authorization, fail closed on drift and conflicts.
- [ ] Support clean installs, upgrades, retries and existing staging setup records.
- [ ] Update admin copy and public docs; mobile/desktop visual proof.
- [ ] Add meaningful setup, consent, deployment and safety regression tests.
- [ ] Run relevant quality checks and local specialist reviews.
- [ ] Verify staging end to end and clean up owned resources.
- [ ] PR, CI, CodeRabbit request/wait, merge, production deploy and basic smoke.

## Acceptance
Admin can enable production email without GitHub variable or Cloudflare dashboard steps, sees proposed DNS changes before applying, and existing mail remains intact. Email remains off until setup succeeds. Fresh install and upgrade paths tested. No known production safety gate bypassed.

## References
https://developers.cloudflare.com/email-service/configuration/domains/
https://developers.cloudflare.com/email-service/configuration/subdomains/
https://github.com/cloudflare/workerd/issues/6740
