# Attach existing agent accounts to projects

## Problem

Raphaël had an unattached Claude account ("SAM Claude") and could not attach it to a
project:

1. Settings → Agents (By provider) shows unattached/pinned account cards, but their
   menu only offers Rename / Remove. There is no way to point a project at an
   existing account from there.
2. Project settings → Agent accounts → "Use another account here" only opens the
   connect-a-new-account sheet. You cannot pick an account you already connected.
3. A named, non-default account should be attachable to several projects.

## Research findings

- Accounts UI: `apps/web/src/components/accounts/` (`AccountCard`,
  `ProviderAccountsRow`, `ProjectAccountRow`, `ProjectAccountsSection`,
  `useAccountActions`, `account-model`).
- An account = one `cc_configurations` row (+ its `cc_credentials`). A project pin =
  a `cc_attachments` row with `project_id` set. `account-model.ts` already models an
  account pinned to many projects (`pinnedProjectIds: string[]`).
- Runtime resolution is composable-credentials first:
  `getDecryptedAgentKey()` → `resolveAgentKeyViaCC()` → `resolveEnvironment()`
  (`packages/shared/src/composable-credentials/resolver.ts`): project attachment →
  user attachment → platform. So a cc attachment is all a project needs.
- The resolver takes the FIRST project attachment for a consumer, so two project
  attachments for the same (user, agent, project) are ambiguous. Today
  `POST /api/cc/attachments` inserts without removing an existing pin.
- `POST /api/cc/attachments` checks `projects.user_id = caller` (owner only), while
  the project pin route `PUT /api/projects/:id/credentials` uses
  `requireProjectCapability(..., 'secret:write')`.
- Removing a pin: `DELETE /api/projects/:id/credentials/:agentType/:kind` already
  handles CC-only pins (no legacy row → `disconnectAgentCredentialFromCC` by kind),
  so the existing `removePin` action works for attachments created here.
- Compute (cloud) project accounts involve capacity pools and a legacy project
  lookup in `provider-credentials.ts`; out of scope — this task covers agent accounts.

## Implementation checklist

- [x] API: project-scoped `POST /api/cc/attachments` replaces any existing project
      attachment for the same (user, consumer, project) atomically (one D1 batch)
- [x] API: project-scoped attach authorizes with `requireProjectCapability(...,
      'secret:write')`, same as the project pin route
- [x] API: refuse to pin an inactive configuration/credential to a project (it would
      halt the project's resolution)
- [x] API behavioral tests against real SQLite (replace, other project untouched,
      cross-user config rejected, non-member project rejected, inactive rejected)
- [x] Web: `useAccountActions` gains `attachToProjects` (add + remove diff)
- [x] Web: `AttachProjectsDialog` — searchable project checklist showing what each
      project uses today
- [x] Web: Settings → Agents account cards (pinned + unattached, agent kind, active)
      get "Use in projects…" in the menu, and a visible button on unattached cards
- [x] Web: Project settings → "Use another account here" opens a picker of existing
      accounts plus "Connect a new account"; falls through to connect when none exist
- [x] Web tests for both flows (rendered behavior, real API call shapes)
- [x] Playwright visual audit, mobile + desktop
- [x] Docs: update user docs describing project account pinning

## Acceptance criteria

- [x] From Settings → Agents an unattached account can be attached to one or more projects
- [x] From Settings → Agents a pinned account can be added to / removed from projects
- [x] From Project settings an existing account can be selected without reconnecting
- [x] Attaching replaces the project's previous pin; the project resolves to the new account
- [x] The same non-default account can be pinned to multiple projects

Staging verification skipped at Raphaël's explicit request (2026-10-31).
