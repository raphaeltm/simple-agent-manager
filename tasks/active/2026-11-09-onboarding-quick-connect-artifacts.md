# Onboarding: quick connect, SAM-hosted repositories, Artifacts on new installs

## Problem (Raphaël, 2026-11-09, after a fresh sam2.party install)
- The "Connect an AI agent" step asked for a pasted auth.json / setup token although SAM has a
  guided sign-in (open a link, enter a code) for Claude Code and Codex.
- He said he did not want GitHub, yet the wizard still showed "Install SAM GitHub App".
- After skipping onboarding, the dashboard said "Import Project", which assumes GitHub.
- Artifacts never appeared when creating a project: the installer never granted the deploy token
  Artifacts access, so `detectArtifactsAvailable` (sync-wrangler-config.ts) failed and
  `/api/config/artifacts-enabled` returned false.

## Research
- Guided connect: `AgentCredentialConnectTrigger` (CodexConnectTrigger.tsx) gated on
  `GET /api/agent-credential-setup-sessions/config`; the wizard duplicated a paste-only form.
- `useSetupStatus.isComplete` required a GitHub installation, so a GitHub-free user would be
  shown onboarding forever.
- Installer token groups: `DEPLOY_ACCOUNT` in `apps/installer/src/credentials.ts`; OAuth scopes:
  `FULL_SCOPES` in `apps/installer/scripts/deploy.mjs`. Live catalog (BYOC account, 2026-11-09):
  "Artifacts Read" / "Artifacts Write", account scope; OAuth scopes `artifacts.read/.write`.
- `ProjectOnboardingWizard` already offers Artifacts when the installation has it enabled.

## Checklist
- [x] Wizard: subscription first, guided sign-in button above the paste fallback (`SubscriptionConnect`)
- [x] Wizard: "Where should your code live?" with "Let SAM host it" only when Artifacts is enabled
- [x] SAM-hosted path skips the GitHub step; project step creates an Artifacts project from a name
- [x] `useSetupStatus`: any project is a repository source (complete without GitHub)
- [x] Dashboard: "New Project" / "Create your first project", copy no longer assumes GitHub
- [x] Installer: optional Artifacts Read/Write on the deployment token, refusal falls back without them
- [x] Installer: `artifacts.read` / `artifacts.write` OAuth scopes in full mode
- [x] Docs: installer.mdx
- [x] Unit tests (questions, path-generator, step-actions, StepExecution, ChoosePathWizard,
      useSetupStatus, dashboard, installer credentials/deploy), each new guard proven discriminating
- [x] Playwright audit at 375 and 1280 (onboarding-inline-audit.spec.ts)
- [x] StepForm.tsx split under 500 lines (SubscriptionConnect.tsx, ActionButton.tsx)
- [x] Specialist review: security-auditor (0 critical/high; ambiguous-catalog test + all-or-nothing grant added), ui-ux-specialist (nested-dialog Escape, mobile screenshot, repo-question layout shift, credential scrub, back-nav lookup all fixed)
- [ ] Staging: redeploy installer, fresh install on the BYOC account, live onboarding with guided sign-in and a SAM-hosted project

## Round 2 (Raphaël, 2026-11-09): thorough decision-tree review + SAM Glass + personality

Findings:
- On a fresh self-hosted install the installer creates no platform cloud credential; agents run on
  Instant (`CF_CONTAINER_ENABLED` on, `decideWorkspaceRuntime`). The old "Use SAM-managed
  infrastructure" choice was a no-op step, and `isComplete` required the user's own cloud
  credential, so an Instant user saw onboarding forever. No client signal existed for Instant.
- SAM-managed AI saves `providerMode`, not a credential, so `hasAgent` stayed false.
- "SAM-managed AI" was offered without checking the installation enables the proxy.
- The onboarding cloud form handled only Hetzner/Scaleway while `CloudProviderConnectFlow`
  handles all seven (duplicate implementation).
- The first chat needed a profile; the composer opened the profile wizard instead.
- PathPreview and the cloud-sam confirmation were screens with no decision.

Checklist:
- [x] `GET /api/config/instant-runtime` (`isInstantRuntimeAvailable`) + client query
- [x] Decision tree asks only open questions (`openQuestions`/`presetAnswers`), runtime first
- [x] Steps omit what the user already has (`generatePath`)
- [x] `useSetupStatus`: compute = own cloud | Instant | platform machines; agent = credential | catalog configured
- [x] OnboardingContext keeps an open overlay up until the hand-off
- [x] Cloud step reuses `CloudProviderConnectFlow`; old cloud form and step removed
- [x] First profile created for the chosen agent/runtime; completion opens `/projects/:id/chat`
- [x] SAM-managed AI gated on `trial-status.hasAgentCredential`
- [x] SAM Glass: void overlay, one Pane, wells, raised tiles, SegmentedControl, SAM speaks first person, Lucide icons
- [x] Removed PathPreview, StepForm, ActionButton, `--sam-onboarding-overlay-bg`
- [x] Unit tests rewritten; new guards proven discriminating; Playwright 24/24 at 375/1280, both themes
- [x] Docs: quickstart, creating-workspaces, api reference
- [ ] Reviews (ui-ux-specialist, security-auditor)
- [ ] Live run-through on a fresh BYOC install
