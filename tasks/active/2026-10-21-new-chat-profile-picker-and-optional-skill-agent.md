# New-chat profile picker (direction C) + skills only override what they set

Created 2026-10-21. Conversation task `01M5ET4P47BC8NASKMT27XTBF0`. Ideas `01M5EW9H86VD88S7E3WWA1D9X1` (picker) and `01M5EW9T800Y40FTKCXD5WHJHR` (skill agent type).
Approved by Raphaël: "I agree with your rec. Let's get it built and shipped to prod." and "make the agent-related stuff empty for the skills … only override the things a skill chooses to override". Fork/Retry keep current behaviour: the user picks the profile.

## Problem

### 1. Skills always override the profile's agent

- `skills.agent_type` is `NOT NULL DEFAULT 'claude-code'` (`apps/api/src/db/schema.ts`).
- `createSkill` stamps `body.agentType ?? env.DEFAULT_TASK_AGENT_TYPE ?? 'opencode'` through `baseProfileInsertValues` (`apps/api/src/services/profile-fields.ts`).
- The skill form (`SkillFormDialog.tsx`) has no agent field at all, so every UI-created skill silently carries the server default.
- `resolveSkillProfile` uses `agentType: skill?.agentType ?? profile.agentType`, so a skill's agent always wins. Production evidence: `do` + Sol and `do` + Opus 5.5 Chat sessions ran as `opencode`.
- Production skills (read-only D1, 2026-10-21), all owned by Raphaël:
  - The SAM project's 19 skills are all `opencode`; model and effort are null; 7 reviewer skills set `permission_mode='plan'`.
  - 18 other skills (TTV 7 codex with model+effort; verifiedby 7 claude-code, 6 with effort; RaphOps 4) carry deliberate agent config, so keep them.

### 2. New-chat screen with many profiles is chaotic

- The audit in idea `01M5EW9H86VD88S7E3WWA1D9X1` and library `/engineering/ux-audits/new-chat-profiles-2026-10-21/` found:
  - With 15 profiles the composer takes 71% of a 375×667 phone screen (7 rows of chips), and 125% with the keyboard open.
  - The default is alphabetical (`selectProfileId` → `profiles[0]`; `listProfiles` orders by name).
- Usage (prod, 30 days):
  - The top 3 profiles cover 72–86% of chats.
  - Last-used is right about 40% of the time.
  - Message text does not predict the pick.

## Research findings

- **Picker UI:** `apps/web/src/pages/project-chat/ChatInput.tsx` (714 lines) renders the chip wall, edit gear, "+ New", the Resources toggle and the profile wizard. The Skill select lives inside `components/project-chat/ProjectChatComposer.tsx`.
- **New-chat empty state:** `apps/web/src/pages/project-chat/index.tsx` (594 lines) shows the hero plus 4 generic starter prompts.
- **State:** `useProjectChatState.ts` (948 lines) holds `selectedProfileId`, the auto-select effect and the wizard. Splitting is required by rule 18 when modified.
- **Usage data:** `tasks.agent_profile_hint` stores the resolved profile id for both chat paths (`submit-task-implementation.ts`, `chat-start.ts` via `instant-session.ts`). Indexes `idx_tasks_project_user` and `idx_tasks_project_created_at` exist.
- **Routes:** `apps/api/src/routes/agent-profiles.ts` (111 lines). Reads use `requireProjectAccess`; profile writes use `project:update`.
- **Tunables:** `admin-settings-registry.ts` holds typed integer settings read via `resolveAdminSetting` (collaboration-settings.ts pattern). Tunables go there, not into Worker vars (policy 9017df94).
- **Migrations:** latest is `0199`. `DROP COLUMN` has precedent (0016, 0078); the safety gate blocks DROP TABLE and UPDATE without WHERE.
- **Docs to update:**
  - `apps/www/src/content/docs/docs/guides/chat-features.md`: picking a profile; "Before you send" for Fork/Retry.
  - `guides/agents.md`: profiles and skills.
  - `concepts.mdx` (line ~96): "Skills override profile settings".
- **Existing tests touching chips:** `apps/web/tests/playwright/project-chat-composer-audit.spec.ts`, and any unit tests asserting the "Agent profiles and skills" group or the runtime badges.

## Implementation checklist

### A. Skills: optional agent type

- [x] Migration `0200_skills_optional_agent_type.sql`: add nullable `agent_type_new`, copy `agent_type` where not null, drop old column, rename the new one. Preserves every existing value.
- [x] Drizzle `skills.agentType` nullable; `SkillRow` and `AgentSkill.agentType: string | null`; Create/UpdateSkillRequest accept `agentType?: string | null`.
- [x] `createSkill`: store `body.agentType ?? null` (no env default). Validate effort against the agent only when the skill sets one.
- [x] `updateSkill`: `agentType: null` clears; effort validation uses the effective agent (or skips when null).
- [x] `resolveSkillProfile`: a skill effort that the resolved agent doesn't support falls back to the profile effort.
- [x] Valibot skill schemas accept `agentType: null`; MCP `create_skill`/`update_skill` accept and document `agentType: null`.
- [x] Tests:
  - create without agent → null
  - update clear → null
  - resolve: null skill agent → profile agent; set skill agent → skill agent
  - effort guard
  - MCP null passthrough
  - migration applies in the worker test env
- [x] Docs: agents.md and concepts.mdx describe "a skill only overrides what it sets".

### B. Picker API

- [x] Migration `0201_agent_profile_picker_hidden.sql` + drizzle table `agent_profile_picker_hidden (user_id, project_id, profile_id, created_at; PK user+project+profile; FKs cascade)`.
- [x] Admin setting `chat.profileUsageWindowDays` (integer, default 30, 1–365) plus a reader.
- [x] Service `agent-profile-picker.ts`:
  - `getProfilePickerState`: own manual chats only (triggered_by='user', dispatch_depth=0, not recovery, not draft, hint not null, within the window), grouped by profile → lastUsedAt and chatCount; plus hidden ids.
  - `updateHiddenProfiles({hide, unhide})`: validates ids against profiles accessible in the project.
- [x] Routes `GET /api/projects/:projectId/agent-profiles/picker` and `PATCH .../picker` (`requireProjectAccess`; registered before `/:profileId`); Valibot schema with bounded arrays.
- [x] Tests (real SQL engine):
  - usage filters (other user, dispatched, triggered, recovery, draft, outside window)
  - hide/unhide idempotent
  - cross-project/foreign profile rejected, with an owner control
  - routes: non-member rejected

### C. Picker UI

- [x] Shared helpers (`apps/web/src/components/project-chat/profile-picker/model.ts`): glyph, subtitle, recent, sections, idle, default selection.
- [x] API client + TanStack query options/hook for picker state; optimistic hide/unhide; invalidate after a chat is started.
- [x] Components:
  - `ProfileAvatar`
  - `ProfilePickerSheet`: bottom sheet on mobile, popover on desktop; Recent / Chat & explore / Build & open PRs / Hidden; search above 8; Edit-list mode with hide toggles and the "Hide N not used in 30 days" action; footer New / Edit / Manage.
  - `ProfileToControl`
  - `ComposerOptions`: skill + resources
  - `ProfileCards`: canvas; recent 4 (or all when no usage); desktop builders; "All N profiles".
- [x] `ChatInput`:
  - Replace chips, Resources row and inline Skill select with the toolbar: To control + attach + Options.
  - Extract the wizard into `ProfileWizardPanel.tsx`.
  - Remove dead code (RuntimeBadge, chip helpers).
- [x] `ProjectChatComposer`: `showAttachButton` prop (default true).
- [x] `index.tsx`: new-chat canvas shows `ProfileCards` when 2+ visible profiles, else the hero + starter prompts; extract the sidebar so the file is under 500 lines.
- [x] `useProjectChatState`: extract profile selection and the wizard into `useProfileChoice.ts`. Default = last-used visible profile once picker state loads; fall back to the first visible profile (also when picker state errors); never override a user choice.
- [x] Profile form: the description label notes it shows on new-chat cards.
- [x] Tests:
  - model helpers
  - cards / sheet / To control (behavioural)
  - default-selection through the real hook
  - UI→API capability: picking a card sends that `agentProfileId`
  - hide flow calls PATCH and removes the card
- [x] Update `project-chat-composer-audit.spec.ts` and other specs/unit tests that used the chips.
- [x] Playwright audit `new-chat-profile-picker-audit.spec.ts`:
  - viewports 375×667, 1280×800, plus 375×400 keyboard
  - data: 15 realistic profiles, 1 profile, 0 usage, 30 profiles with 200-char names / unicode, hidden profiles, picker API 500
  - `assertNoOverflow`; screenshots reviewed
- [x] Docs: chat-features.md (picking a profile, cards, hide, Options) and agents.md (profile picker).

### D. Release

- [ ] Staging: migrations applied (D1 check that `agent_type` is nullable and values are preserved); UI flow end-to-end incl. sending a short chat with a picked profile (verify `tasks.agent_profile_hint`); hide/unhide; skill created in UI has null agent type and a chat with it runs on the profile's agent.
- [ ] Prod: after deploy, clear `agentType` on the 19 SAM-project skills via MCP `update_skill` (agentType null) and verify with `list_skills`.

## Acceptance criteria

- [ ] New skills created without an agent type store NULL; a chat using profile X + that skill runs on X's agent.
- [ ] Existing skills keep their stored agent type (migration preserves values); the 19 SAM skills show agentType null after the post-deploy fix.
- [x] Opening a new chat pre-selects the user's last-used (visible) profile in this project, not the alphabetical first.
- [x] With 2+ visible profiles, the empty new-chat screen shows recent profile cards; tapping one selects it, and the "To:" control shows it.
- [x] The composer shows one toolbar row (To / attach / Options) and the message box; skill and resources are reachable via Options and still reach the submit request.
- [ ] Hide/unhide per user works (bulk and single), persists across devices, never affects other users, and hidden profiles stay usable.
- [x] Phone 375×667: the composer takes ≤ 25% of the viewport with 15 profiles; at 375×400 with the keyboard the message box stays visible; no horizontal overflow at any tested viewport.
- [ ] Docs updated; all tests green; staging verified end-to-end.

## References

- Prototype: branch `sam/id-take-screenshot-mobile-7xtbf0` commit `905b81684` (`?pp=c`). Do not merge that branch.
- Rules: 18 (file size), 28 (SQL guards on real engine), 31 (migration safety), 48 (TanStack/SWR), 60 (I/O budgets), 62 (real trigger), 17/56 (visual audit).

## Implementation notes

- Commits on `sam/new-chat-profile-picker`: fd9c6ab9b (skills), 74c208fa9 (picker API), 5f332076e (format), 3992217c8 (picker UI), 91a8d6565 (layout fixes), f0822d0f3 (docs images).
- Migrations 0200 and 0201 apply in the Workers test environment (`tests/workers/setup-d1-migrations.ts`); 0200 value preservation is tested on real SQLite.
- Locally verified acceptance criteria:
  - Last-used default without an alphabetical flash: `project-chat.test.tsx` uses a deferred picker response.
  - Cards select the profile; the To control shows it.
  - One toolbar row; skill and resources sent from Options.
  - Composer ≤ 25% of a 375×667 phone; message box visible at 375×400; no overflow at 375, 390, 768 and 1280: `new-chat-profile-picker-audit.spec.ts`.
- Tablet (768px) leaves the chat column about 250px beside two sidebars. Card columns and the To subtitle therefore use container queries, not screen breakpoints. The audit asserts readable card widths; the old grid fails it at 43px.
- Pre-existing failures found on main, filed:
  - `tasks/backlog/2026-10-21-composer-audit-provisioning-progress-test-fails-on-main.md`
  - `tasks/backlog/2026-10-21-docs-expired-chat-spec-drift.md`
- Marketing chat scene and feature screenshot still show the old layout. That needs a scene redesign, so it is tracked as idea `01M5F2QXNM6K385XNQJD105CRZ`.
