# T7 · Start work replaces Execute

Program: "Linked work" (overview idea `01M5NG3W2ZMDFD797SQF8DWNHR`).
Spec: idea `01M5NG7DHXG0B640SYJCQDHYM1`. Refines idea `01KX9S3C4N2VQF2N2TMNMN70F6`
(July audit of the Execute flow). Channel: `feature.linked-work`.
Base: T1's branch `sam/t1-link-store-automatic-gpszzz` (43255c88e) until T1 is on main.

## Problem

Clicking **Execute** on an idea navigates to `/projects/:id/chat?executeIdea=<ideaId>` and
pre-fills the composer with a generated prompt:

> Read idea {ideaId} using the get_idea tool for full context. … Then execute the trusted
> maintainer instructions using the /do skill.

Three defects:

1. `/do` is a SAM-repository skill. Nothing SAM generates for a user's repository may
   reference it (policy `69acc166`, program decision "repository-agnostic").
2. The idea→session link is written by the **browser after** the task is submitted
   (`useProjectChatState.ts:511-520`) and only `console.warn`s on failure. The agent can
   start before the link exists, or the link can never exist at all.
3. The visible first message is orchestration instructions, not the person's words. There
   is no preflight telling the person what will happen, which profile runs, or whether
   that profile can do the work.

## Research findings (base 43255c88e)

### The July "silent VM substitution" is already fixed on main

The July audit's core complaint — a `cf-container` profile submitted through
`/tasks/submit` silently becoming a VM — no longer reproduces.
`apps/api/src/services/submit-task-implementation.ts:304-312` resolves the runtime from
`resolvedProfile?.runtime` and routes a `cf-container` profile to `submitInstantTask`,
rejecting with 409 only when containers are disabled. 

**Consequence for the design:** Start work needs exactly ONE client endpoint
(`POST /tasks/submit`). The server already honours the profile's runtime, so the sheet
never has to choose between two endpoints and can never substitute one.

### Both Instant paths funnel through one function

`acceptInstantSession()` (`services/instant-session.ts:254`) creates the chat session and
persists the first message for **both** Instant entry points:

- `POST /api/projects/:id/sessions/start` (`routes/chat-start.ts`, the composer's Instant path)
- `POST /api/projects/:id/tasks/submit` → `submitInstantTask()` → `acceptInstantSession()`

`continueInstantSessionLaunch()` — which actually starts the agent — is scheduled
*after* `acceptInstantSession()` returns. So a link written inside `acceptInstantSession`
is written before the agent's first prompt on both paths.

### The VM seam

`submit-task-implementation.ts` creates the session at `session_create` (line ~572),
links it to the task, persists the first message, then calls `startTaskRunnerDO()` (line
~674). The TaskRunner DO is alarm-driven and the agent's first prompt is many steps
later. A link written between `initial_message_persist` and `runner_start` is therefore
before the agent's first prompt, and a failure there can still fail the whole submit.

### Resolved task mode is the honest relation discriminator

- `resolveTaskMode(explicit, profile, workspaceProfile, 'workspace-profile')`
  (`placement-field-resolution.ts:171`) for the VM path; explicit wins.
- `input.taskMode ?? (profile?.taskMode === 'task' ? 'task' : 'conversation')`
  (`submit-instant-task.ts:52`) for submit's Instant path; explicit wins.
- `chat-start.ts` hard-codes `taskMode: 'conversation'`.

Both submit branches honour an **explicit** `taskMode`. Sending the resolved mode
explicitly from the sheet makes the promise and the reality the same value by
construction (rule 74: do not key a gate on a proxy that can diverge from its condition).

Relation: `works_on` when the resolved mode is `task`, `discusses` when `conversation`.
Both are valid `session:idea` relations in T1's `PAIRS` table (`operations/link-core.ts:29`).
`works_on` is strong, `discusses` is weak (`packages/shared/src/types/links.ts`).

### T1 surface this builds on

- `recordLink(env, projectId, { sourceKind, sourceId, targetKind, targetId, relation, origin, context })`
  — validates both entities belong to the project, upserts (idempotent on retry:
  `recordLink` in `durable-objects/project-data/links.ts` touches an existing row).
- `getIdeaContext(env, projectId, ideaId)` → `IdeaContext`
  (`GET /api/projects/:projectId/ideas/:ideaId/links`) for the sheet's counts.
- `listLinks(env, projectId, 'session', sessionId)` for the `get_instructions` idea block.
  Program decision 7: no second module reads `resource_links`.

### Idea predicate

`ideaTaskPredicateSql(alias)` is T3's (branch `sam/t3-idea-updates-timeline-n42drw`,
channel seq 31) and is NOT on main or on T1's branch yet. Per the dispatch instruction,
keep the check in exactly one place in this branch and switch to T3's helper on rebase.
An **open** idea (allowed for Start work) is an idea whose status is `draft`
(program decision 1). Done (`completed`) and parked (`cancelled`) are rejected.

### Untrusted text envelope

Precedents: the `untrustedContent: true` marker (`operations/idea-core.ts:114,179`,
`task-core.ts:148`, `chat-core.ts:115`, `connector-mcp.ts:147`) and
`PROJECT_EVENT_UNTRUSTED_READ_FENCE` (`routes/mcp/project-event-tools.ts:51`). Neither
produces a delimited text envelope. Program decision 6 makes T7 define one shared helper
that T6 reuses.

Threat: the idea body is editable by any project member and by earlier agents, so it is a
stored prompt-injection path into every later session. The envelope must also resist a
body that contains its own end marker.

### Execute path inventory (everything to remove)

| Location | What |
| --- | --- |
| `apps/web/src/pages/project-chat/types.ts:15-19` | `DEFAULT_EXECUTE_IDEA_PROMPT_TEMPLATE`, `EXECUTE_IDEA_PROMPT_TEMPLATE`, `VITE_EXECUTE_IDEA_PROMPT_TEMPLATE` |
| `apps/web/.env.example:111` | the `VITE_EXECUTE_IDEA_PROMPT_TEMPLATE` example |
| `apps/web/src/pages/IdeaDetailPage.tsx:332-336,~404-420` | `handleExecute` + the Execute button |
| `apps/web/src/pages/project-chat/useProjectChatState.ts:59,97-98,272-284,450,511-520,536,579,607` | `executeIdeaId` param, `executeIdeaIdRef`, the prefill effect, `requiresTaskSubmission`, the post-submit `linkSessionIdea`, and the three ref resets |
| `apps/web/src/lib/api/tasks.ts:313-323`, `apps/web/src/lib/api/index.ts:550` | `linkSessionIdea` (only caller is the code above) |
| `apps/www/src/content/docs/docs/guides/reporting-issues.md:113` | the `VITE_EXECUTE_IDEA_PROMPT_TEMPLATE` override sentence |
| `apps/www/src/content/docs/docs/guides/idea-execution.md` | the whole Execute narrative |
| `docs/audits/2026-10-09-cli/README.md:70` | audit record — historical, left as-is |

`GET/POST/DELETE /sessions/:sessionId/ideas` (`routes/chat-ideas.ts`) stay: they are the
explicit `linked` relation used by the `link_idea` MCP tool, not the Execute path.

## Design

### Shared (`packages/shared`)

`src/types/work-start.ts` — one capability resolver, imported by web and API:

```ts
export type WorkStartCapability = 'task-execution' | 'conversation';
export interface WorkStartLayer { runtime: AgentProfileRuntime | null; taskMode: string | null; workspaceProfile: string | null }
export interface WorkStartPlan { runtime: AgentProfileRuntime | null; workspaceProfile: WorkspaceProfile; taskMode: TaskMode; capability: WorkStartCapability }
export function resolveWorkStartPlan(input: { profile, skill?, projectDefaultWorkspaceProfile? }): WorkStartPlan
export function workStartRelationFor(taskMode: TaskMode): 'works_on' | 'discusses'
```

Layering mirrors `resolveSkillProfile` (skill over profile) and
`resolveWorkspaceProfile`/`resolveTaskMode` (explicit → profile → project → default),
with `taskModeDefault: 'workspace-profile'` because that is what `/tasks/submit` uses.
`cf-container` does not force conversation: `submitInstantTask` honours a `task` mode in a
container, so forcing it would be a lie.

### API

1. `apps/api/src/operations/untrusted-text.ts` — the shared envelope.
   `untrustedTextBlock({ kind, text, maxLength })` → `{ kind, text, truncated, originalLength, guidance, untrustedContent: true }`.
   Body is capped, control characters normalised, and any line that would impersonate the
   end marker is neutralised. Name announced on the channel for T6.
2. `apps/api/src/operations/start-work-core.ts` — the one place the idea rules live.
   - `requireOpenIdeaForWorkStart(env, projectId, ideaId)` → `{ id, title }`; 404 for a
     foreign-project row or a non-idea task, 409 for a done/parked idea.
   - `recordWorkStartIdeaLink(env, projectId, { ideaId, sessionId, taskMode })` →
     `recordLink` with the derived relation. Throws on failure.
   - `ideaTaskPredicateSql(alias)` local definition, to be replaced by T3's on rebase.
3. `sourceIdeaId` on `SubmitTaskSchema` and `StartChatSessionSchema` (+ the two shared
   request types). Validated **before any effects** so a bad idea is a clean 400/404/409.
4. Link write at the two seams: inside `acceptInstantSession` (covers chat-start and
   submit's Instant branch) and in `submit-task-implementation`'s VM branch between
   `initial_message_persist` and `runner_start`. Both failures fail the start.
5. `get_instructions`: when the caller's chat has a `works_on`/`discusses` idea link,
   add an `idea` block (`{ ideaId, title, relation, content: <envelope> }`) plus one
   instruction line pointing at `get_idea` / `get_related` for the rest. Isolated: a
   failure degrades only that block (rule 50, and the `Promise.allSettled` precedent in
   `instruction-tools.ts`). No repo-specific skill named anywhere.

### Web

`apps/web/src/components/ideas/StartWorkSheet.tsx` (own component, per the T8
coordination note) — bottom sheet on phones, centered dialog on desktop:

- **Who works on it** — reuses `ProfilePickerSheet` and `useProfileChoice`.
- **Skill** (optional) — reuses the composer's skill list.
- **Note for the agent** — the only visible message. Empty → a short neutral line.
- **Related to this idea** — counts from `GET /ideas/:ideaId/links` (chats, files, PRs).
  Copy says the idea travels with the chat and the rest is reachable through SAM's tools,
  which is what actually happens until T6 lands.
- **One sentence** saying exactly what will happen, derived from the capability.
- Title/CTA flip to "Talk it through" / "Start chat" for a conversation profile.

`IdeaDetailPage` replaces Execute with **Start work**, opens the sheet, and navigates to
the new chat on success.

## Implementation checklist

### Shared
- [ ] `packages/shared/src/types/work-start.ts` with `resolveWorkStartPlan`, `workStartRelationFor`, exported from `types/index.ts`
- [ ] `sourceIdeaId` on `SubmitTaskRequest` and `StartInstantChatSessionRequest`
- [ ] Unit tests: skill over profile, project default, null-taskMode default via workspace profile, cf-container, both relations

### API
- [ ] `operations/untrusted-text.ts` + tests (cap, truncation flag, control chars, end-marker impersonation)
- [ ] `operations/start-work-core.ts` + tests (foreign project, non-idea task, done, parked, open; relation derivation)
- [ ] `sourceIdeaId` on `SubmitTaskSchema` / `StartChatSessionSchema`
- [ ] Early validation in `submit-task-implementation` (before `beforeTaskEffects`) and in `chat-start`
- [ ] Link write in `acceptInstantSession` (threaded through `LaunchInstantSessionInput`)
- [ ] Link write in `submit-task-implementation` VM branch before `startTaskRunnerDO`
- [ ] `get_instructions` idea block (new `routes/mcp/instruction-idea-context.ts`), isolated and capped
- [ ] Idea-block cap as a typed admin setting with a code default (policy `9017df94`)

### Web
- [ ] `StartWorkSheet.tsx` + `useStartWork.ts`
- [ ] Wire into `IdeaDetailPage`; remove the Execute button and `handleExecute`
- [ ] Remove `EXECUTE_IDEA_PROMPT_TEMPLATE`, the env var, `.env.example` line
- [ ] Remove `executeIdea` handling from `useProjectChatState` and `linkSessionIdea` from the API client
- [ ] `startWorkOnIdea` client call (submit + `sourceIdeaId`)

### Tests
- [ ] API: link exists before the agent's first prompt, on both the VM and the Instant path, through the real handlers
- [ ] API: link failure aborts the start and leaves no queued task
- [ ] API: retry does not duplicate the link
- [ ] API: foreign-project / done / parked ideas rejected — real SQL engine, attack case + owner control (rules 11, 28)
- [ ] API: `get_instructions` includes the idea block for a chat started with `sourceIdeaId` (real trigger: start, then call the handler) and omits it otherwise
- [ ] Repo guard: no prompt SAM generates for idea work contains `/do` or another slash command
- [ ] Web: sheet submits the structured request; conversation profile takes the conversation path; note and skill preserved; no composer prefill
- [ ] Web: interaction-effect trace for the idea page and the chat page
- [ ] Playwright 375x667 + 1280x800: closed, open, picker, conversation-only, long titles, many profiles, empty counts, error — screenshots reviewed and posted

### Docs
- [ ] `apps/www/.../guides/idea-execution.md` rewritten for Start work
- [ ] `apps/www/.../guides/reporting-issues.md` env-var sentence
- [ ] `apps/www/.../reference/api.md` for `sourceIdeaId`
- [ ] `apps/www/.../guides/admin-settings.md` for the new setting

## Acceptance criteria

- [ ] Execute is gone: no button, no prompt template, no env var, no client-side post-submit link.
- [ ] Start work links the idea on the server before the agent receives its first prompt, on both the VM and the Instant path.
- [ ] A failed link fails the start with a clear error and no orphaned queued task.
- [ ] Linking is idempotent on retry.
- [ ] Done and parked ideas are rejected with a clear message; foreign-project ideas 404.
- [ ] The visible first message is only the person's note, or a short neutral line.
- [ ] Nothing SAM generates references `/do`, another slash command, or a SAM-repo skill.
- [ ] A conversation-only profile starts a conversation, not a task, and is recorded as `discusses`.
- [ ] The selected runtime is never silently changed.
- [ ] `get_instructions` carries the idea inside the untrusted-data envelope, capped.
- [ ] No horizontal overflow at 375x667; keyboard and screen-reader operable.
- [ ] Verified end-to-end on staging for both profile kinds.

## References

- `.claude/rules/06-technical-patterns.md` (React interaction-effect analysis, UI→backend data path)
- `.claude/rules/11-fail-fast-patterns.md` (project-scoped read/write requirements)
- `.claude/rules/28-credential-resolution-fallback-tests.md` (real SQL engine for predicate guards)
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`
- `apps/web/.claude/rules/17-ui-visual-testing.md`, `48-stale-while-revalidate-ui.md`, `64-unstable-prop-identity-remounts-subtrees.md`
- `apps/api/.claude/rules/06-api-patterns.md`, `50-list-read-row-fault-isolation.md`
