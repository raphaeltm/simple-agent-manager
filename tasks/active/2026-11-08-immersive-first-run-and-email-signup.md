# Immersive first run and email sign-up

## Problem

Raphaël ran a real installer install (sam2.party, 2026-11-08) and reported:

1. "SAM is ready" (installer maintenance panel) is dull.
2. "Finish setting up SAM": the instruction "Open your instance and enter this setup token." is buried in a paragraph far from the token and button.
3. "First-run setup" (`apps/web/src/pages/Setup.tsx`) has no design: a wall of OAuth forms.
4. After pasting the token the page cannot scroll.
5. Installs should request email permissions, allow email triggers by default, and let the first user sign up with email.

## Research findings

- Scroll bug: `apps/web/src/index.css` sets `html, body, #root { overflow: hidden }` at >=768px. `Setup.tsx` is outside the shell and uses `min-h-screen` with no scroll container of its own, so the tall form is clipped.
- Setup can only complete with an OAuth provider (`validateSetupCanComplete`, `platform-config-validation.ts:251`).
- BetterAuth 1.7.14 has no email sign-in configured. `emailOTP` creates the user with `emailVerified: true`, so the installer owner gate (`bootstrap-owner.ts`) accepts it unchanged.
- SAM can send email only through the `AGENT_EMAIL` send binding (`services/agent-email/provider.ts`), generated when `configure-agent-email.ts` prepares Email Sending for `agents.<BASE_DOMAIN>`. The installer engine runs that step only for `legacy-ci` (`installer-engine.ts:392`), and installer tokens have no email permissions (`apps/installer/src/credentials.ts`), so installer installs cannot send email.
- Inbound agent email (triggers) is turned on by `runAgentEmailSetup` with a consent token for root-domain changes (policy: admin preview and consent). It uses the Worker's `CF_API_TOKEN` (installer runtime token), which also lacks email permissions.
- Live `GET /oauth/scopes`: `email-sending.write`, `email-routing-rule.write`, `zone-settings.write` exist.

## Design

- Installer: add those three OAuth scopes; add Email Sending Write (account) and Zone Settings Write + Email Routing Rules Write (zone) to the deployment and runtime tokens (runtime also Email Sending Read). The engine prepares email sending for installations too; failure there never fails an install. Upgrades with old tokens skip email (the script probes permissions).
- API: `emailOTP` plugin when the send binding exists. Codes go out from `sign-in@agents.<BASE_DOMAIN>`. New accounts by email only for the first user (installer owner email, or no users yet); existing users can always use email. Per-IP and per-email send limits. Setup can complete with email sign-in alone. Setup verify returns the owner email, email sign-in availability and the agent email plan; setup complete can turn agent email on with the plan's consent token.
- Web: immersive setup wizard (welcome + token, sign-in, agent email, done), own scroll container, token auto-filled from the installer link's URL fragment. Landing gets email-code sign-in.
- Installer maintenance: celebratory ready panel; setup handoff puts the instruction next to the token and button; the button carries the token in the fragment.

## Implementation checklist

- [ ] API email sign-in service + plugin + rate limits
- [ ] API login-providers `email` flag
- [ ] API setup verify/complete changes + validation
- [ ] Web auth client emailOtp + Landing email sign-in
- [ ] Web Setup wizard rebuild + scroll fix
- [ ] Installer scopes + token permission groups + tests
- [ ] Engine prepares agent email for installations + tests
- [ ] Installer maintenance ready + handoff redesign + browser audit
- [ ] Docs (self-hosting, installer, auth)
- [ ] Playwright audits 375/1280 for Setup, Landing, maintenance pages
- [ ] Staging deploy + verify; fresh BYOC install verify email sign-in end to end

## Acceptance criteria

- [ ] A fresh install can finish setup without any OAuth app and the owner signs in with an emailed code.
- [ ] Non-owner emails cannot create accounts before the owner exists; unknown emails get no code afterwards.
- [ ] Setup page scrolls on desktop and mobile.
- [ ] Agent email turns on during setup when the owner keeps it on, with DNS changes previewed.
- [ ] Existing installs and CI deploys keep working (email step skipped without permissions).
