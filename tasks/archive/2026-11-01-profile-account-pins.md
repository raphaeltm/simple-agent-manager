# Personal profile account pins (phase 1)

SAM task: `01M6CM9YSMDJJR6DV9BK39YP3D`. Design approved by Raphaël on 2026-11-01 in task
`01M6CFZXQC129BHTRTD5RRVHYA`. Team/shared accounts are out of scope (idea
`01M6CM8WST5QG1DKST2NWNNJPP`).

## Problem

A person cannot say "when I run profile _Opus deep work_, use my Claude Max account". Agent
credentials resolve project pin → user default → platform, with no profile tier. Each member's
choice must be private and apply only to their own runs, in single-person and shared projects.

## Research findings

- Resolver: `packages/shared/src/composable-credentials/resolver.ts` `resolveEnvironment()`.
  Project tier halts on an inactive attachment and on a configuration/credential that cannot
  materialize; user tier falls through to platform.
- Snapshot: `apps/api/src/services/composable-credentials/snapshot.ts` `buildSnapshot()`;
  wrapper `resolve.ts` `resolveForConsumer()`.
- Callers of agent resolution (all must get the profile):
  - `apps/api/src/routes/credentials.ts` `getDecryptedAgentKey()` / `resolveAgentKeyViaCC()`
    used only by `POST /:id/agent-key` in `apps/api/src/routes/workspaces/runtime.ts`.
  - `getSelectedAgentCredentialReference()` used by
    `apps/api/src/durable-objects/task-runner/provider-limit-admission.ts`.
  - `resolveProxyUpstream()` in `apps/api/src/routes/ai-proxy-passthrough.ts`; auth from
    `verifyAIProxyAuth()` in `apps/api/src/services/ai-proxy-shared.ts`.
  - `apps/api/src/routes/resolution-status.ts` (display only, project scope, owner only) and
    `apps/api/src/services/provider-credentials.ts` (compute) need no profile.
- `resolveAgentKeyViaCC()` treats a CC `null` as "no match" and falls back to the legacy table
  when the user already has CC data. A halted profile pin has no legacy row, so the halt would
  silently fall through to the legacy user credential. The resolver must report halts so the
  caller can stop (also fixes the same gap for cc-only project pins).
- `mapSourceToLegacy()` (credentials.ts) and `credentialSourceFromResolution()`
  (ai-proxy-passthrough.ts) map unknown sources to `'platform'`; a new `profile-attachment`
  source would be treated as a platform credential and dropped by the agent-key route (rule 79).
- `agent_sessions.agent_credential_source` has `CHECK (... IN ('user','project','platform'))`
  (migration 0158) and so does `credential_limit_windows.credential_source`. Writing `'profile'`
  would violate the CHECK; changing it needs a table rebuild, which rule 31 forbids. Decision:
  a profile pin is a user-owned credential (`credential_source = 'user'`), and the tier is
  recorded in a new nullable column `agent_sessions.agent_credential_scope`
  (`'profile' | 'project' | 'user' | 'platform'`), added with `ALTER TABLE ADD COLUMN`.
- Profile context: `resolveWorkspaceRuntimeAssetContext()` in
  `apps/api/src/services/workspace-runtime-assets.ts` resolves session → task → workspace hint
  and validates the profile (project profile or the workspace user's global profile).
- Project pin route: `POST /api/cc/attachments` in
  `apps/api/src/routes/composable-credentials-attachments.ts` requires `secret:write`
  (maintainers lack it). Unpin via PATCH/DELETE `/api/cc/attachments/:id` is owner-scoped only.
- Offboarding: `apps/api/src/services/project-offboarding-apply.ts` and
  `project-offboarding-preview*.ts`; member status flips to `removed` at the end of apply.
- File sizes: `credentials.ts` (1271) and `runtime.ts` (1991) are already over 800 lines.
  Agent-key resolution helpers move out of `credentials.ts` into a service module as part of
  this change instead of growing it.
- Web: `apps/web/src/components/accounts/*` (#2485), `useAccounts.ts` TanStack Query hooks,
  `account-model.ts` runs the shared resolver client-side over listed rows.

## Implementation checklist

### Shared
- [ ] `AttachmentScope` gains `{ scope: 'profile'; userId; profileId }`; `ResolutionContext`
      gains `profileId` and `profileAgentType`; `ResolutionSource` gains `profile-attachment`.
- [ ] `explainResolution()` returns the result plus a per-tier trace (used / skipped / halted /
      not set, with reasons); `resolveEnvironment()` delegates to it.
- [ ] Profile tier: most specific; agent consumers only; skipped when the pin's agent type is not
      the running agent type; inactive pin or inactive configuration/credential halts.

### API
- [ ] Migration: `cc_profile_attachments` table (FKs cascade, unique on
      user/profile/consumer) and `agent_sessions.agent_credential_scope` column.
- [ ] Drizzle schema for both.
- [ ] Snapshot loads the caller's profile pins for the given profile only.
- [ ] `resolveProfileCredentialContext()` helper: validates profile for (user, project) and
      computes `skill.agentType ?? profile.agentType`.
- [ ] Move agent-key resolution out of `credentials.ts`; pass profile; halt is definitive.
- [ ] agent-key route passes the session's profile; attribution records scope.
- [ ] Admission passes the task's profile/skill.
- [ ] Proxy auth carries session profile/skill; `resolveProxyUpstream()` passes it; source map
      handles `profile-attachment`; attribution records scope.
- [ ] Audit every reader of the credential source enum / resolution source (rule 79).
- [ ] CRUD routes `/api/cc/profile-attachments` (list, candidates, create-replaces, patch, delete)
      with valibot schemas, paused-account refusal, profile access check (own global profile or
      project profile with `task:write`), same not-found for missing and foreign.
- [ ] Project pin create requires `task:write` instead of `secret:write`.
- [ ] Offboarding preview counts the member's pins on the project's profiles; apply deletes them.

### Web
- [ ] API client + TanStack Query hooks for profile pins and candidates.
- [ ] Profile editor "Account" section (usual account / pinned account, paused disabled, skill
      warning, private label in shared projects, "Runs on X" with breakdown disclosure).
- [ ] Settings → Agents account card: "Use in profiles…" dialog and list of pinning profiles.
- [ ] Project settings → Accounts: show profiles that override the project pin.
- [ ] Session details: chosen account and source.
- [ ] Offboarding preview shows the pins that will be removed.
- [ ] Playwright audit 375px / 1280px with stress data.

### Docs
- [ ] `apps/www/src/content/docs/docs/guides/agents.md` and credential-resolution docs.

## Acceptance criteria / tests
- [ ] Resolver: profile pin beats project pin; inactive profile pin halts; agent-type mismatch
      skipped; no pin = unchanged; global profile handled; another user's pin never applies.
- [ ] Capability test: agent-key, admission and proxy choose the same account for a
      profile-pinned session.
- [ ] Halted profile pin does not fall back to the legacy credential at agent-key.
- [ ] Profile pins coexist with project pins; offboarding deletes them.
- [ ] Maintainer can pin their own account to a project; viewer cannot.
- [ ] Pin creation authorization tested on a real SQL engine with foreign-user attack + owner
      control.
- [ ] Guards proven discriminating by deletion.
- [ ] Staging: pin a profile to a non-default account, chat, confirm `agent_sessions` attribution
      and a response; unpin and confirm fallback.
