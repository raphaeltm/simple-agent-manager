# Token cloud providers: first-run onboarding wizard parity

**Filed by:** the Vultr provider PR (`sam/implement-vultr-fourth-cloud-qf96ez`), per rule 42 (tracked follow-up for a deliberately-deferred slice).

## Problem

The DigitalOcean and Vultr cloud providers ship fully usable via **Settings → Cloud Providers** (their single-token credential forms), the unified **`CloudProviderConnectFlow`**, and `CreateWorkspace`. It is intentionally NOT yet offered in the **first-run onboarding wizard** (`choose-path`), because that wizard uses a hardcoded binary `hetzner`-vs-`scaleway` model with `scaleway` as the implicit `else` branch — adding a third option requires converting two binary ternaries to explicit 3-way branches, which is out of scope for the initial provider PR.

The 5 "has-cloud-provider" detection gates (incl. onboarding completion checks) DO already include `vultr` and `digitalocean`, so users with only one of those credentials is correctly treated as having a cloud provider and is not nagged. Only the wizard's provider-*selection* UI omits Vultr and DigitalOcean.

## Scope (make onboarding offer Vultr and DigitalOcean)

- `apps/web/src/components/onboarding/choose-path/step-actions.ts`
  - `:25` `export type CloudProvider = 'hetzner' | 'scaleway';` → add `'vultr'`.
  - `StepFormState` (~48-65) + `INITIAL_FORM` (~67-80): add `vultrToken: string` / `''`.
  - `cloud-byoc` execute (~163-200): add explicit Vultr and DigitalOcean single-token arms (validate + `createCredential({ provider: 'vultr', token })`) **before** the scaleway fallthrough — mirror the hetzner single-token arm.
- `apps/web/src/components/onboarding/choose-path/StepForm.tsx`
  - `cloudDisabled` (~356-359): convert the binary check to 3-way.
  - Provider toggle (~376): `(['hetzner', 'scaleway'] as const)` → include `'vultr'`.
  - Render ternary (~394-466): convert the binary `hetzner ? … : scaleway` to an explicit 3-way branch adding Vultr and DigitalOcean single-token inputs (with the "Allow All IPv4/IPv6" hint).
- `apps/web/src/components/onboarding/choose-path/StepExecution.tsx:93-95`: reset both token fields to the field reset.

## Acceptance criteria

- [ ] Onboarding wizard offers Hetzner / Scaleway / Vultr / DigitalOcean; selecting either token provider runs its own create path (NOT the scaleway fallthrough).
- [ ] Playwright visual audit of the onboarding cloud step with each token provider selected (375 + 1280), overflow-asserted.
- [ ] Staging: complete onboarding with bogus Vultr and DigitalOcean keys → clean sanitized error; with no key → correct gating.

## References
- Parent PR / task: `tasks/archive/2026-07-23-vultr-cloud-provider.md`
- Rule 42 (no untracked degrading placeholders — this is the tracked follow-up), Rule 26 (project-chat-first — onboarding is secondary).
