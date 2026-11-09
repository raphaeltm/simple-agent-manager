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
- [ ] Specialist review
- [ ] Staging: redeploy installer, fresh install on the BYOC account, live onboarding with guided sign-in and a SAM-hosted project
