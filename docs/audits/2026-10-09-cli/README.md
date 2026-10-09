# SAM CLI audit: assistant and voice workflows

Implementation follow-up: Raphael subsequently authorized implementation. [Current command documentation](../../../apps/www/src/content/docs/docs/reference/cli-project-workflows.md) records implemented scope and deferred consequential writes. The findings below retain the original baseline.

Date: 2026-10-09. Source snapshot: `5199e5771eb6519e78a8a4d451dcaa2726ae7fcd`, verified against remote `main` during the audit. Audit branch: `sam/audit-sam-cli-coverage-hvw14r`.

## Executive summary

**The CLI is useful for selected lists and submission, but is not yet reliable enough for an assistant to carry out the project sidebar's workflows end to end.** This is a proposed implementation plan; none of the missing capabilities has been implemented or exercised against production.

1. Fix command truthfulness before expanding writes: unknown flags are ignored, including `--dry-run`; invalid profile hints can fall back to a different agent; invalid project selection in `status` becomes a successful account-wide list.
2. Complete reads are the largest foundational gap. Chat reads one page; lists lose pagination metadata; message JSON loses ordering and tool metadata; profile JSON loses model, effort, runtime and scope; project dashboard counts are read from the wrong shape.
3. Core task lifecycle, profile creation/update, all skills management, follow-up messages, permission/attention responses, and session lifecycle are missing or partial. The task submit/status commands exist but are hidden from help and bypass normal project resolution.
4. All 13 current project sidebar destinations were inventoried. Comments, Files, Deployments, Events and Settings have no corresponding CLI workflow. Existing notifications are account-wide even with `--project`.
5. Existing tests pass: CLI package coverage **83.1%**, combined module **82.9%**. Synthetic audit fixtures reproduce the limitations below. Passing statement coverage does not establish API parity.
6. Recommend read-only settings inspection first, followed only by an approved small allowlist of low-risk writes. Credentials, permissions, access, spending, runtime assets, deployments and destructive operations need separate decisions. CLI capability is not assistant authorization.

## Scope, evidence and safety

Source of truth is the rendered navigation definition, its routed pages and current API handlers/services—not CLI help or a historical API reference. The sidebar is defined at [NavSidebar.tsx](../../../apps/web/src/components/NavSidebar.tsx#L56), and page routing at [App.tsx](../../../apps/web/src/App.tsx#L292). Hidden experimental Agent navigation is excluded; Activity is part of Agent Context, not an extra project sidebar destination. Ideas routes to `IdeasPage`/`IdeaDetailPage`, not the older `ProjectTasks` screen.

This is a source/contract audit with local command-boundary tests, not a live authenticated browser audit. No production resource mutations, user-settings changes, chat sends, task launches, deployments, merges, credentials or private transcript reads occurred. SAM task metadata and repository refs were read to track the separately assigned fix. Go 1.26.6 was downloaded into `/tmp` because this workspace had no Go binary. No application source was changed. Tests use fake HTTP and disposable configuration directories; no production authentication is needed.

Reproduce with Go 1.26.6 and a C compiler for race instrumentation:

```sh
bash docs/audits/2026-10-09-cli/reproduce.sh
# Optional absolute toolchain path:
GO_BIN=/path/to/go bash docs/audits/2026-10-09-cli/reproduce.sh
```

[reproduce.sh](reproduce.sh) runs baseline race/coverage, then copies [observations_test.go.txt](observations_test.go.txt) into a **temporary CLI copy**, runs the audit observations under race detection, and runs `go vet`. The nine top-level observation tests, including eight field-loss scenarios and both chat output modes, passed. They assert current defects for reproducibility; they are not acceptance tests to keep after fixes. There is intentionally no duplicate Attention decoder test here.

### Source index

References below resolve relative to this report; line anchors identify the audited revision.

| Key | Current UI source | API source/contract |
| --- | --- | --- |
| T | [Chat submission/state](../../../apps/web/src/pages/project-chat/useProjectChatState.ts#L597); [IdeasPage](../../../apps/web/src/pages/IdeasPage.tsx), [IdeaDetailPage](../../../apps/web/src/pages/IdeaDetailPage.tsx#L332) | [tasks client](../../../apps/web/src/lib/api/tasks.ts), [submit handler](../../../apps/api/src/routes/tasks/submit.ts#L166), [task CRUD](../../../apps/api/src/routes/tasks/crud.ts#L160), [task schemas](../../../apps/api/src/schemas/tasks.ts#L66) |
| S | [Chat state](../../../apps/web/src/pages/project-chat/useProjectChatState.ts#L739), [session API client](../../../apps/web/src/lib/api/sessions.ts) | [chat detail/messages](../../../apps/api/src/routes/chat.ts#L162), [list](../../../apps/api/src/routes/chat-session-list.ts#L117), [message query semantics](../../../apps/api/src/routes/chat-message-query.ts), [prompt](../../../apps/api/src/routes/chat-prompt-route.ts#L20), [interactions](../../../apps/api/src/routes/chat-acp-interactions.ts#L219) |
| P | [ProjectProfiles](../../../apps/web/src/pages/ProjectProfiles.tsx), [ProfileList](../../../apps/web/src/components/agent-profiles/ProfileList.tsx) | [profile routes](../../../apps/api/src/routes/agent-profiles.ts), [schemas](../../../apps/api/src/schemas/agent-profiles.ts), [resolver](../../../apps/api/src/services/agent-profiles.ts#L300), [base fields](../../../apps/api/src/services/profile-fields.ts#L52) |
| K | [ProjectSkills](../../../apps/web/src/pages/ProjectSkills.tsx), [SkillList](../../../apps/web/src/components/skills/SkillList.tsx) | [skills routes](../../../apps/api/src/routes/skills.ts), [schemas](../../../apps/api/src/schemas/skills.ts), [override resolution](../../../apps/api/src/services/skills.ts#L258), [runtime assets](../../../apps/api/src/services/profile-runtime-assets.ts) |
| C | [ProjectComments](../../../apps/web/src/pages/ProjectComments.tsx), [comments client](../../../apps/web/src/lib/api/comments.ts) | [project inbox](../../../apps/api/src/routes/project-comments.ts#L41), [session comments](../../../apps/api/src/routes/chat-comments.ts), [library comments](../../../apps/api/src/routes/library-comments.ts) |
| F | [ProjectFiles](../../../apps/web/src/pages/ProjectFiles.tsx), [BrowseView](../../../apps/web/src/components/project-files/BrowseView.tsx), [ChangesView](../../../apps/web/src/components/project-files/ChangesView.tsx) | [remote repo API](../../../apps/web/src/lib/api/repo-browse.ts#L55), [repo handlers](../../../apps/api/src/routes/projects/repo-browse.ts#L75); separate workspace/session [files client](../../../apps/web/src/lib/api/files.ts#L340) |
| L | [ProjectLibrary](../../../apps/web/src/pages/ProjectLibrary.tsx), [library client](../../../apps/web/src/lib/api/library.ts) | [library routes](../../../apps/api/src/routes/library.ts#L206) |
| A | [AgentContextPage](../../../apps/web/src/pages/AgentContextPage/index.tsx#L76), [MemoryTab](../../../apps/web/src/pages/AgentContextPage/MemoryTab.tsx), [PoliciesTab](../../../apps/web/src/pages/AgentContextPage/PoliciesTab.tsx) | [knowledge](../../../apps/api/src/routes/knowledge.ts), [policies](../../../apps/api/src/routes/policies.ts), [activity client](../../../apps/web/src/lib/api/sessions.ts) |
| N | [ProjectNotifications](../../../apps/web/src/pages/ProjectNotifications.tsx#L99) | [notifications client](../../../apps/web/src/lib/api/notifications.ts#L15), [routes](../../../apps/api/src/routes/notifications.ts) |
| E | [ProjectEvents](../../../apps/web/src/pages/ProjectEvents.tsx), [panels](../../../apps/web/src/components/project-events) | [events client](../../../apps/web/src/lib/project-events-api.ts), [subscriptions](../../../apps/api/src/routes/project-event-subscriptions.ts), [channels](../../../apps/api/src/routes/project-event-channels.ts), [schedules](../../../apps/api/src/routes/project-schedules.ts), [watches](../../../apps/api/src/routes/project-standing-watches.ts) |
| R | [ProjectTriggers](../../../apps/web/src/pages/ProjectTriggers.tsx), [ProjectTriggerDetail](../../../apps/web/src/pages/ProjectTriggerDetail.tsx) | [triggers client](../../../apps/web/src/lib/api/triggers.ts), [CRUD](../../../apps/api/src/routes/triggers/crud.ts#L163), [actions](../../../apps/api/src/routes/triggers/actions.ts), [history](../../../apps/api/src/routes/triggers/executions.ts) |
| D | [ProjectDeployments](../../../apps/web/src/pages/ProjectDeployments.tsx), [environment detail](../../../apps/web/src/pages/ProjectDeploymentEnvironmentDetail.tsx) | [deployment client](../../../apps/web/src/lib/api/deployment.ts#L226), [environments](../../../apps/api/src/routes/deployment-environments.ts), [releases](../../../apps/api/src/routes/deployment-releases.ts) |
| G | [ProjectSettings and seven tabs](../../../apps/web/src/pages/ProjectSettings.tsx#L35), [settings components](../../../apps/web/src/components/project-settings) | [project client](../../../apps/web/src/lib/api/projects.ts#L158), [GET/runtime](../../../apps/api/src/routes/projects/crud.ts), [PATCH](../../../apps/api/src/routes/projects/project-update.ts#L44), [mapper](../../../apps/api/src/lib/mappers.ts#L159) |
| CLI | [dispatch/help](../../../packages/cli/internal/cli/run.go#L15), [commands](../../../packages/cli/internal/cli/commands.go), [parser](../../../packages/cli/internal/cli/args.go), [project resolver](../../../packages/cli/internal/cli/project_resolve.go) | [HTTP client](../../../packages/cli/internal/cli/client.go), [JSON types](../../../packages/cli/internal/cli/types.go), [output/errors](../../../packages/cli/internal/cli/run.go#L663), [main/context](../../../packages/cli/cmd/sam/main.go) |

## UI / API / CLI parity matrix

`P` below means `/api/projects/:projectId`. Status: **implemented** = usable narrow operation; **partial** = subset/incomplete data; **missing** = no command; **broken** = observed mismatch. A listed API mutation is inventory, not permission to execute it. API identifiers are exact IDs unless a resolver is explicitly noted. Source keys link the entire UI → API chain above; every CLI row maps to CLI dispatch/client/types.

### Tasks, chat, profiles and skills

| UI workflow / sources | API contract | Existing CLI and status | Assistant contract assessment / effect |
| --- | --- | --- | --- |
| Select project (G) | `GET /api/projects` with `limit,cursor`; `GET P` | `projects`, `project`, `project use`, `status`: **partial/broken** | Modern commands resolve full ID, unique uppercase ID prefix ≥5, or case-insensitive exact name; duplicates fail. Only first project page searched. `project use` writes local defaults and can prompt; do not use for an unattended one-off. `project/status` count shape is wrong. |
| Submit autonomous task (T) | `POST P/tasks/submit`; 202 with task/session/branch/status | Hidden `task submit` / `tasks dispatch`: **partial** | Accepts prompt, profile hint, mode, agent, resources, parent/node/provider/container options; JSON receipt. Requires explicit project ID or positional project; does not use normal name/default resolution. Starts work/compute immediately; no confirmation or idempotency key. |
| New conversational chat (T,S) | Submit above; UI also uses `POST P/sessions/start` for eligible Instant runtime | `chat new`: **partial** | Resolves project; profile hint forwarded. Forces `taskMode=conversation` even if `--mode=task` supplied. Submit handler also resolves runtime, so do not infer Instant is impossible solely from different URL. Selection parity needs a contract test. No skill/attachments. |
| Select profile/skill before launch (T,P,K) | Submit accepts `agentProfileId,skillId`; profile/skill overlay services | Profile option exists; skill option absent: **partial/broken** | Profile accepts ID or exact name server-side, with project-before-global precedence; unknown hint falls back. CLI does no preflight or ambiguity check. `--skill` is silently discarded. Skill can override agent/model/runtime, so display effective selection before work. |
| Read task outcome/detail (T) | `GET P/tasks/:id` flat detail; includes dependencies, blocked, lineage, placement, outputs; `GET .../:id/sessions`, `/events` | Hidden `task status`: **partial** | JSON keeps basic outcome/output/error fields, discards description, profile/skill, workspace/session links, blocked/dependencies/placement. Successful read exits 0 even when task failed: read success is different from work success. No task name/prefix resolver, watch or wait. |
| List tasks / Ideas (T) | `GET P/tasks?status&minPriority&sort&limit&cursor` → tasks,nextCursor | `ideas` (draft only): **partial**; full task list **missing** | One page; no filters/cursors; JSON drops descriptions and nextCursor. Current Ideas UI drains bounded draft pages and discloses truncation. |
| Create/update task or idea (T) | `POST P/tasks` creates draft; `PATCH .../:id`; `POST .../:id/status` validates transitions | **missing** | Need distinct draft creation vs launch vs status transition. Updates/status can affect resources and completion; don't label all as harmless metadata. |
| Execute/link an Idea (T,S) | UI pre-fills Chat using `executeIdea`; submission plus `POST P/sessions/:id/ideas`; `GET P/tasks/:id/sessions` | **missing** | Current UI executes from composer and links the resulting session; it is not just the old `/run` operation. Proposed CLI must preserve this association and profile/skill choice. |
| Task dependencies/delegate/run/delete (T) | `/tasks/:id/dependencies` POST/DELETE; `/delegate`, `/run` POST; DELETE task; `/close` POST | **missing** | APIs exist beyond current Ideas page. `/run` is a distinct legacy task lifecycle; deletion/close can clean up resources. Prioritize only those needed for chosen workflow, not every historical route. |
| List/find sessions (S) | `GET P/sessions?status&limit&offset&scope=my|all` → sessions,total; default page 20, max 100 | `chat`: **partial/broken** | One page, no filtering/scope; drops total, task outcome/state/ownership/workspace/profile context. Attention object currently fails decoding. Exact session ID only; displayed 7-character IDs are not resolved by chat view. |
| Read transcript/message contents (S) | `GET P/sessions/:id?limit&before&after`; `/messages` additionally supports roles,compact,order; `/messages/:messageId/tool-content` lazy archived content | `chat <id>`: **partial/broken** | One newest page, `hasMore` retained only in JSON; no traversal/warning in text. Preserves basic role/content/time; drops sequence, origin, toolMetadata. Cannot hydrate compact tool payloads or distinguish archived-unavailable. Same Attention decoding risk. |
| Continue a session / wake sleeping session (S) | `POST P/sessions/:id/prompt` → durable accepted/queued IDs when enabled; may wake compute | **missing command** | `SendPrompt` client method exists but is unreachable from CLI dispatch. No guarantee that `chat send` does this: currently it means “view session with ID send.” Receipt must distinguish acceptance from execution. |
| Answer attention or ACP interaction (S) | `POST .../attention/:markerId/resolve`; `GET .../interactions`; `POST .../interactions/:id/answer` | **missing** | Needed to finish work; exact request/marker/options and expired/already-resolved semantics. Permission/authentication questions must remain human-controlled absent specific authorization; never auto-approve merely to unblock. |
| Cancel, sleep, archive/close (S) | `/sessions/:id/cancel`, `/stop`; workspace `/sleep`; task `/close` | **missing** | UI maps working→Stop, awake idle→Sleep, sleeping→Archive. Cancel a turn vs release resumable compute vs terminal closure are separate operations. Respect creator/capability checks; do not expose archive as an awake idle shortcut. |
| Fork/retry session (S) | UI builds deterministic lineage-prefilled composer; Retry reads original user prompt; new submit carries parentTaskId | **missing** | CLI can return a proposed prompt/lineage read-only, then launch only on explicit instruction. No LLM summary step. Exact original prompt access requires forward pagination; not “first message in latest page.” |
| Profile list / inspect effective config (P) | `GET P/agent-profiles` includes project + caller global; `GET /:id`; `POST /resolve` computes without saving | `profiles`: **partial**; get/resolve **missing** | No subcommands. JSON loses scope/model/effort/runtime/permissions/prompts/timeouts/provider. Cannot reliably answer “does Sol use the right model?” Resolve POST is semantically read-only, unlike task submit. |
| Profile create/update/delete (P) | POST collection, PUT `/:id` partial-field schema, DELETE `/:id` | **missing** | APIs enforce project:update; names checked for duplicates in project. Needs explicit project vs global scope, null/clear vs omission, field-specific write boundary. Global rows can be read but project mutation predicates do not match them (see source-inferred gap below). Permissions/GitHub policy/resource fields are consequential despite same endpoint. |
| Skills list/get/create/update/delete (K) | GET/POST `P/skills`; GET/PATCH/DELETE `/:id` | **missing** | Skills are SAM setting bundles with profile defaults and overriding fields, not simply repository SKILL.md files. List includes global skills; execution resolver tries global skills by ID but project skills by name. Scope/precedence must be visible. |
| Profile/skill runtime env/files (P,K) | GET/POST/DELETE `.../:id/runtime/env-vars` and `/files` | **missing** | Metadata reads can be safe; non-secret values still may be private. Writes inject material into future agents and may change executable behavior. Separate from ordinary profile labels; no secrets in JSON/errors. |

### Other project sidebar resources

| UI workflow / sources | API contract | Existing CLI and status | Assistant contract assessment / effect |
| --- | --- | --- | --- |
| Comments inbox/thread inspection (C) | `GET P/comments` filters/paging; `GET P/sessions/:id/comments`; library comment APIs | **missing** | Needed to inspect human feedback in project scope without reading unrelated transcripts. Include anchor/message/session linkage and status. |
| Comment/reply/resolve/send to agent (C) | Session comments POST, replies POST, resolve/send POST; `clientMutationId` for create/reply | **missing** | Note creation is a write; send-to-agent triggers delivery/work. Keep separate actions. Reuse existing mutation IDs where supported; do not infer send idempotency from note dedupe. |
| Files: remote branch/tree/file/raw/compare (F) | `GET P/repo/{branches,tree,file,raw,compare}` with exact ref/path/head/base | **missing** | Actual sidebar Files reads the remote repository; it is not live workspace files. Preserve tree/patch truncation and binary/oversize metadata. No task launch needed for this existing UI API, but assistant policy can independently restrict repository investigation. |
| Live session/workspace files and git (F,S) | `P/sessions/:id/files/*`, `/git/*`; direct VM worktree APIs | **missing** (port helpers are separate) | Distinguish uncommitted runtime files from repo refs; sleeping/unavailable runtime should be explicit, not implicitly provisioned on read. Upload/worktree mutation belongs to separate scoped authorization. |
| Library list/find/metadata/content/download (L) | `GET P/library` directory/search/tags/type/status/sort/limit/cursor; metadata/download/preview/directories | `library [--recursive|--all]`: **partial** | `--all` here only means recursive directories, not all pages. Cursor/total retained in JSON but cannot be passed back; text hides paging. Content/download/search/directory selection missing. File bytes need stream/output-file contract separate from JSON metadata. |
| Library upload/replace/move/tag/delete/comment (L,C) | `/upload` POST, `/:id/replace` PUT, `/move` PATCH, `/tags` POST, DELETE; comments routes | **missing** | Useful for artifacts/attachments; replacement/delete can lose data. Upload IDs/limits/checksums and path disambiguation needed. Preview-token minting is not ordinary read-only GET. |
| Agent Context memory list/read/search (A) | `P/knowledge` list limit/offset/type; `/search`; `/:id` → observations,relations | `context`: **partial** | Entity summaries only; no observation contents/search/relations, loses totals. Cannot inspect actual instructions from names/counts. |
| Agent Context memory edits and policies (A) | knowledge/entity/observation PATCH/DELETE; `P/policies` GET/list/detail/PATCH/DELETE (+ API POST) | **missing** | UI edits/deletes memory and policy records. Policy changes alter future assistant authority/behavior; classify separately from routine documentation. |
| Agent Context activity/actions (A) | `GET P/activity?eventType&sessionId&before&limit` → events,hasMore | `activity`: **partial** | Payload retained; actor/session/task/workspace IDs and hasMore dropped; one page, no filters. This is not the Events sidebar. |
| Notifications read/filter/read-mark/dismiss (N) | `GET /api/notifications?projectId&sessionId&type&filter&limit&cursor`; read/dismiss POST | `notifications`: **partial/broken parity** | Project flag ignored; fetches account list. Body/metadata/action/project/session linkage dropped; nextCursor kept but no controls. No marks/dismiss. Read should never mark/dismiss implicitly. |
| Events subscriptions/delivery outcomes (E) | `P/event-subscriptions` GET/detail/deliveries; `/cancel` POST | **missing** | Agent needs evidence of delivery vs mere acceptance; cancellation is a mutation. Do not confuse viewing delivery with acknowledging it. |
| Events channels/history (E) | `P/event-channels` cursor/limit; `/:channel/history` cursor/watermark/hasMore/retentionGap | **missing** | Read-only visibility is valuable; expose retained-history gap explicitly. Agent channel publish/follow APIs currently live through MCP, not these read-only REST handlers. Do not invent REST CLI endpoints. |
| Events schedules/watches (E) | GET/list/detail and POST create; schedule reschedule/cancel/reconcile; watch update/pause/revoke | **missing** | Existing schedule keys and expectedVersion prevent unsafe replay/stale writes. Scheduled start/message and standing watch create ongoing effects/compute. Default reconcile is observation; explicit retrySubmission can submit work. |
| Triggers list/detail/history/preview (R) | GET list/detail/executions/webhook deliveries; `/test` or webhook preview POST | `triggers`: **partial** | List is unpaginated at API; CLI discards prompt/profile/skill/config/timezone/execution/attribution. Detail/history missing; preview must be identified as non-launching and tested separately. |
| Trigger create/edit/pause/run/delete/token rotate (R) | POST create; PATCH state/config; `/run` POST; DELETE; `/webhook/rotate` POST | **missing** | Automation and run can spend resources; deletion and rotation consequential. Never print webhook credentials into assistant output. Existing secret handoff direction is a design constraint, not permission for this audit. |
| Deployments inspection (D) | `P/environments` GET/detail; releases/events, routes/domains, volumes, logs/metrics/containers/config | **missing** | Prioritize read-only status and failure evidence; redact logs and config values, expose cursors/availability. No automatic start on reads. |
| Deployment environment/create/start/stop/delete; releases/config/volumes/domains (D) | environments POST/PATCH/DELETE; lifecycle POST; releases POST; config/volumes/custom-domains mutation routes | **missing** | Scope separately: changes can affect traffic, spend, persistent data and secrets. Do not add all deployment writes merely for sidebar parity. |
| Settings inspection/writes (G) | Project GET/PATCH plus dedicated access/connection/runtime/deployment/capacity APIs | Project GET **partial**; dedicated settings **missing** | See field-level boundary table below. No existing CLI project-settings mutation command. `project use` is only local default mutation. |

### Settings: three separate capability classes

All seven current tabs are accounted for. **Recommendation is metadata-first inspection**, an explicitly approved minimal write allowlist, and consequential writes deferred. “Read-only” does not mean safe to disclose secret values or private configuration.

| Tab / current workflow | Read-only capability to propose first | Potential routine writes (decision required) | Consequential writes to keep separate |
| --- | --- | --- | --- |
| General | Name, description, repo/ref, status, timestamps and current user capabilities via project GET | Rename; optional description (API supports it even if tab currently only renames) | Project deletion; repository/default branch rebinding affects future code execution and must not be bundled with rename |
| Access | Membership/roles, pending requests, attribution health; [members APIs](../../../apps/api/src/routes/projects/members.ts), [transfer](../../../apps/api/src/routes/projects/ownership-transfer.ts) | None by default | Invite grant/revoke, request approval/denial, role/removal/offboarding, ownership transfer; invite URLs are sensitive bearer material |
| Connections | Presence/provider and credential health only; [connections UI](../../../apps/web/src/components/project-settings/ProjectConnectionsSection.tsx), [credential routes](../../../apps/api/src/routes/projects/credentials.ts) | None by default | Cloud/agent credential changes; repository access expansion/removal; never reveal raw credential/token material |
| Agents | Default selection and effective non-secret configuration/permission policy | Possibly choose an **existing** default profile/agent, only if approved; profile label/description | permissionMode, GitHub CLI rights, arbitrary system instructions, credential binding; model/effort/budgets also influence spend/behavior and deserve a separate allowance |
| Infrastructure | Resource requirements, timeouts, scaling/default capacity pools; [capacity defaults](../../../apps/web/src/components/project-settings/DefaultCapacityPoolsPanel.tsx), [ScalingSettings](../../../apps/web/src/components/ScalingSettings.tsx) | None initially; bounded timeout change only after explicit review | Provider/location/resources/concurrency/pool limits/warm retention can increase spending or terminate work; not automatically low-risk numeric settings |
| Runtime | Env/file key/path, isSecret/hasValue, timestamps, MCP server presence; [runtime helper masking](../../../apps/api/src/routes/projects/_helpers.ts#L183), [MCP routes](../../../apps/api/src/routes/mcp-connections.ts) | Non-secret values/files **not** routine by default: they can be executable or credentials mislabeled as plain text | Secret writes/deletes, file injection, MCP endpoint/command/auth changes and removal; require secure input/output channel and scoped authorization |
| Deploy | Enabled integrations and environment/domain/config metadata; [DeploymentSettings](../../../apps/web/src/components/DeploymentSettings.tsx), [project deployment routes](../../../apps/api/src/routes/project-deployment.ts) | None initially | Deployment identity/credentials, DNS, routes, secrets, policy/spend; start/stop/delete/rollback separately authorized |

Do not implement a generic `settings patch --json-body` that bypasses these categories. Underlying APIs sometimes share one schema and capability; the CLI must reject disallowed fields locally, and any promised enforcement against malicious callers needs server-side scoped authorization. `--yes` may suppress a local prompt; it is **not** a substitute for human approval or server permissions. No authentication/security redesign is authorized here.

## Key defects and evidence

| Priority | Finding | Reproduction / source | Consequence and proposed remedy |
| --- | --- | --- | --- |
| P0 | Unrecognized flags/subcommands silently succeed | `TestAuditUnknownMutationFlagsIgnored`: fake `chat new --skill=fixture-skill --dry-run` makes POST without skillId. `TestAuditSubcommandWordsIgnored`: `profiles create` makes GET and exits 0. [parser](../../../packages/cli/internal/cli/args.go#L90), [dispatch](../../../packages/cli/internal/cli/run.go#L40) | Safety promises and requested operations disappear. Strict per-command flags/arity; implement dry-run only if truthful, otherwise reject before any request. Extra positional words also rejected. |
| P0 | Explicit invalid profile can silently launch defaults | [resolveAgentProfile](../../../apps/api/src/services/agent-profiles.ts#L407) returns defaults with null profileId; task submission uses [resolveSkillProfile](../../../apps/api/src/routes/tasks/submit.ts#L335). Source-proven; no live launch attempted | A typo/voice recognition error can change model/provider. Preflight exact IDs/scope, fail unknown/ambiguous hints; server must also fail explicit unknown selection rather than using fallback. Missing hint fallback is a different contract. |
| P0 dependency | Session.Attention object decoder regression | `types.go` Session.Attention is `*string`; real object in [session API](../../../apps/web/src/lib/api/sessions.ts#L88). Existing fix task contains production reproduction (exit 1 INVALID_JSON) | Assigned elsewhere; affects list/detail and shared project recentSessions/status. Do not duplicate its implementation/tests. Consume verified fix before declaring those reads reliable. |
| P1 | Transcript is incomplete, without text disclosure | `TestAuditChatPaginationFlagsIgnored`; [GetSessionDetail](../../../packages/cli/internal/cli/client.go#L175), [runChatView](../../../packages/cli/internal/cli/commands.go#L248) | `--limit`/`--before` do nothing; `hasMore=true` still exits 0. Add exact cursors, explicit completeness metadata/text warning, bounded all-pages export and tool-content reads. |
| P1 | JSON drops data needed for reasoning/paging | Eight `TestAuditJSONFieldLoss` scenarios plus message case; [types.go](../../../packages/cli/internal/cli/types.go) | Missing totals/cursors, scope/model/runtime, task associations, notification bodies, message sequence/tool metadata. `--json` is a re-serialized subset, not full API JSON. Define full supported models or preserve additive fields deliberately; verify contract fixtures. |
| P1 | Dashboard can display zero when actual summary is nonzero | Project GET returns counts inside `summary` ([crud](../../../apps/api/src/routes/projects/crud.ts), [mapper](../../../apps/api/src/lib/mappers.ts#L159)); CLI reads top-level counters. Fixture nested activeWorkspaceCount=3 loses summary | Source-backed incorrect counts, not just missing convenience. Decode actual summary and preserve unknown/unavailable vs zero. Current tests use unrealistic top-level detail counters. |
| P1 | `status` suppresses invalid-project/resolution errors | `TestAuditStatusInvalidProjectFallsBack`; [runStatus](../../../packages/cli/internal/cli/commands.go#L116) catches every resolution error | Wrong/missing/ambiguous project or list failure can yield successful project listing. Only intentional no-default case may fall back; explicit failed selection exits nonzero. |
| P1 | Project selection and identifiers inconsistent | `TestAuditLegacyProjectNameIsLiteral`, `TestAuditLegacyTaskIgnoresActiveProject`; [projectFromArgs](../../../packages/cli/internal/cli/args.go#L137) vs [ResolveProject](../../../packages/cli/internal/cli/project_resolve.go#L24); [TruncateID](../../../packages/cli/internal/cli/table.go#L66) | Hidden task paths literally use `SAM`; defaults are ignored. Modern project resolver only searches first page. Text presents shortened session/task/profile IDs that consumers cannot resolve. Use shared project resolver and explicit resource-specific exact/name/prefix contracts; surface full IDs in JSON. |
| P1 | Project notification scoping silently ignored | [runNotifications](../../../packages/cli/internal/cli/commands.go#L414) calls account endpoint without project; UI sends projectId | Assistant may summarize other projects accidentally. Honor explicit project; require explicit account scope for cross-project list. Preserve body/action linkage and pagination. |
| P1 | Unsafe manual retry after lost submit/prompt response | [SubmitTaskSchema](../../../apps/api/src/schemas/tasks.ts#L66) has no replay key; CLI has no retries/receipt reconciliation; [prompt route](../../../apps/api/src/routes/chat-prompt-route.ts#L47) generates new delivery without client key | No automatic retries today (good), but manual retry can duplicate compute/messages. Requires server key/immutable-intent replay and receipt lookup before advertising safe CLI retry. Profile/skill duplicate-name conflict is not an idempotent receipt. |
| P1 | Errors are unstructured and server error text may echo sensitive data | `TestAuditJSONErrorIsPlainTextAndCanEchoServerBody` uses synthetic canary (not printed); [parseAPIError](../../../packages/cli/internal/cli/client.go), [fail](../../../packages/cli/internal/cli/run.go#L663) | `--json` failure leaves empty stdout/plain stderr; no retryable/status classification; raw non-JSON error bodies pass through. Redact/allowlist error messages and define machine-readable error schema. This audit proves a disclosure path, not a production leak. |
| P2 | Help hides supported workflows and is not command-specific | [helpText](../../../packages/cli/internal/cli/run.go#L672), hidden dispatch cases; `TestAuditHelpConsumesFollowingPositional` | Profile/prompt/mode flags and task submit/status undiscoverable; `-h` not parsed as short help; `--help chat`/`chat --help session` order changes parsing. Add root/subcommand help with required IDs, effects, output/paging and unsupported flags. |
| P2 | Ordinary HTTP operations lack deadline/signal cancellation | [main.go](../../../packages/cli/cmd/sam/main.go#L13) uses Background + http.DefaultClient; forwarding implements separate signals | Voice assistant can wait indefinitely on a hung request; interruption may strand uncertainty. Add configurable timeout/context cancellation with unknown-outcome messaging for writes. Response cap (default 1 MiB, configurable) already fails loudly; pagination must work within it rather than simply raising it. |

Additional parser consequences: no end-of-options delimiter handling, bare optional flags may consume following prompt words, repeated ordinary selectors use last value, and `--json=false` is not equivalent to a boolean global setting. Strict validation should cover these together; no new parsing framework is necessary if focused helpers remain simple.

Two API limitations should also shape implementation, rather than blaming the CLI alone:

- **Global profile/skill update/delete can report success without mutation through project routes.** Read access includes the caller's global rows, but [profile update/delete](../../../apps/api/src/services/agent-profiles.ts#L264) and [skill update/delete](../../../apps/api/src/services/skills.ts#L238) constrain the SQL write to `projectId=projectId`. A global row has null projectId; the subsequent read/success response does not establish a write. This is a source-inferred reachable no-op, not a live-tested mutation. A scoped CLI should reject this target until an explicit global mutation contract is chosen; no global write expansion is implied.
- **Task cursor and alternative sort orders disagree.** [task list](../../../apps/api/src/routes/tasks/crud.ts#L199) filters `id < cursor` while `updatedAtDesc`/`priorityDesc` sort by other fields first. Source analysis indicates paging can skip or repeat rows when these orders diverge. Initially expose only a proven ordering or fix tuple cursors and test the chosen sort; adding `--all-pages` alone is insufficient.

### Active fix coordination

Owner: task `01M4FXD7J933ZYZ9DMAZP40R38`, session `c86837b7-f86a-4c45-bf38-be75d63d5354`, branch `sam/fix-sam-cli-session-p40r38`. Metadata read during this audit: `in_progress`, no PR/completion evidence recorded; remote branch head `303394ec254c5608c9549195e949f3c02b170c0e`. The owner covers populated/null/omitted Attention objects, affected list/detail/shared consumers, text/JSON and regression tests. No edits, checkout, or duplicate Attention regression tests were made. Metadata tracking supplied coordination without sending a chat prompt to the peer.

**Chat pagination remains a separate gap even after that fix.** Do not mark it fixed merely because session decoding succeeds. Re-check the fix's eventual PR/test evidence before implementation begins; this report does not assert that it has merged or deployed.

## Cross-cutting CLI contract assessment

| Dimension | Current behavior | Recommended acceptance contract |
| --- | --- | --- |
| Discovery/help | Flat help, hidden task aliases, no skill/settings namespace | Canonical discoverable task/session/profile/skill commands; old aliases remain compatible but documented as aliases; contextual help and machine-readable capability inventory if needed after basic help is complete |
| Project/profile choice | Modern project name/prefix/default; legacy project literal; profile server fallback; no explicit global profile scope | Unattended writes require resolved explicit project and intended profile ID; read commands may use default while reporting effective project. Exact name/unique prefix matching, scope shown, duplicate candidates returned; no fuzzy auto-selection from speech |
| JSON | Successful typed subset; help/device auth/forwarding output are special cases | Stable schemas for result/error; full IDs, scope, receipt/completeness/continuation; progress on stderr. Device authorization instructions stay usable without corrupting JSON. Do not assume every command already obeys global JSON flag |
| Exit/errors | General 0 success / 1 failure; task status reflects fetch success; runner doctor returns 0 even for failed readiness | Document operation success vs terminal task outcome. Stable error code/status/retryable details first; decide differentiated exit codes separately to avoid breaking scripts. Proposed `task wait` nonzero on failed/cancelled/expired outcome, clear timeout exit |
| Pagination/transcripts | API supports paging; CLI requests one page; drops many continuation fields | Every pageable list exposes exact continuation + completeness; all-pages opt-in with bounds/snapshot semantics. Read through tied timestamps using createdAt/sequence/id, not timestamp-only cursors. Never claim full history on a partial page |
| Ambiguity | Modern projects fail duplicates in fetched page; profile project-name shadows global; other resource names/short IDs unhandled | Return candidates (full ID/name/scope) and ask user only when intent is ambiguous; require canonical ID for consequential mutation. Scope constraints apply before resolution |
| Idempotency/retries | No CLI automatic HTTP retries or submit replay keys; schedule APIs already version/key aware | Bounded retry only for classified safe reads; writes only with real server replay contract. Unknown outcomes surfaced for reconciliation; changed-intent key conflict; explicit retry is a new attempt only when asked |
| Confirmation | Work starts immediately; local project picker prompts; no general confirmation/dry-run feature | Never wait on stdin invisibly in unattended mode. Operation effect metadata and opt-in previews; local confirmation distinct from assistant approval. Reversible explicitly requested task submit need not incur redundant “are you sure?”; risky approval never implied by `--yes` |
| Read vs mutate | Lists nominally observational; auth login saves config; project use saves local default; forward opens listeners and mints credentials | Help labels observational/local-write/remote-write/compute/credential effects. A read may warm caches/server indexes but must not launch work or alter user settings. No generic “everything GET is harmless” rule |

Authentication boundary: existing CLI uses cookie-based HTTP with `SAM_API_TOKEN` exchange fallback and `SAM_SESSION_COOKIE`/`SAM_API_URL` configuration. It does not consume task MCP identity simply because `SAM_MCP_TOKEN` is present. Assistant execution must use the user's approved credential context and existing server capability checks. Introducing delegated CLI scopes would be a security design decision, not a free side effect of adding commands.

## Realistic workflow readiness

| Voice intent | Current end-to-end result | Minimal completion needed |
| --- | --- | --- |
| “In SAM, ask Sol to audit this and leave a draft PR.” | Hidden submission can work with full project ID/profile ID and explicit instruction in prompt; no skill choice, preflight, safe replay or robust inspection loop | Show resolved project/profile/effective runtime; submit once with receipt/replay key; get full task/session outcome; complete transcript; follow-up and interaction handling. Draft/no-merge constraint remains prompt intent, not a CLI merge permission |
| “What did that agent do, including its tool results?” | Latest page only; tool metadata discarded; list can fail Attention decode | Session discovery and task mapping; exact transcript export, archived tool content availability, privacy-aware summary using only requested session |
| “Create a review profile like Sol, use high effort, then make a reusable skill.” | Profiles list lacks model/effort; no create/update/skills command | Full scoped reads/clone proposal, approved profile/skill field writes, null-vs-inherit semantics and resource/security field gates; never mutate shared Sol as an implicit shortcut |
| “Find that Idea and run it with Sol; let me know when done.” | Ideas only one page/no description; no linked execute/wait | Pageable Ideas + get/detail, original title/description/session links, explicit linked execution receipt, task wait/subscription observations and reliable terminal result |
| “Reply to the agent / answer its question.” | No reachable send or answer command | Exact session/question ID, supported answer validation, accepted vs delivered outcome; human answers security prompts. Deduped prompt delivery and no implicit permission escalation |
| “Show settings; rename the project; give someone access.” | Project read is incomplete; no writes | Inspection first; rename if low-risk class approved; access grant remains separately authorized/consequential. Do not use a generic patch to bridge it |
| “Pause nightly work and show its last failure.” | Trigger list only, loses context/history | Detail/history + explicit pause operation if automation-write class approved; pause is not deletion, and “test” must not mean “run” |
| “Show files/artifacts and whether the app is healthy.” | Library metadata only; no remote Files or deployment reads | Repo ref/content/compare, library read/download, environment/status/logs with redaction; no implicit deployment or wake |

Voice should be an intent-to-structured-arguments layer, not a new speech subsystem in the CLI. Reuse external transcription, pass argv as an array, and add prompt/body input from stdin/file so quotes, newlines, leading `--`, and shell metacharacters are preserved without interpolation. An assistant should resolve names before requesting writes and describe actual receipts rather than say “done” on 202 acceptance.

### Example commands: existing versus proposed

**Existing read syntax** (examples only; no authenticated production CLI calls were run):

```sh
sam projects --json
sam profiles --project SAM --json
sam task status '<full-task-id>' --project '<full-project-id>' --json
sam chat '<exact-session-id>' --project SAM --json
sam library --recursive --project SAM --json
```

The chat example is a **single page**, not a transcript export. The library example traverses directories, not pages. Existing hidden submission syntax, shown only to document discoverability and not executed:

```sh
sam task submit --project '<full-project-id>' \
  --agent-profile '<full-profile-id>' --mode task \
  --prompt 'Audit the requested workflow; deliver findings and a plan; do not implement or merge.' --json
```

**Proposed syntax, not implemented**, illustrating the phased contract:

```sh
sam task list --project SAM --status in_progress --all-pages --json
sam task get '<task-id>' --project SAM --json
sam profiles get Sol --scope global --project SAM --json
sam skills list --project SAM --json
sam chat messages '<session-id>' --project SAM --limit 100 --before '<exact-cursor>' --json
sam chat export '<session-id>' --project SAM --all-pages --format ndjson --output transcript.ndjson
sam settings inspect --project SAM --json
sam task submit --project SAM --agent-profile Sol --profile-scope global \
  --skill '<skill-id>' --prompt-file request.txt --idempotency-key '<stable-request-key>' --json
sam task wait '<task-id>' --project SAM --timeout 10m --json
sam chat send '<session-id>' --project SAM --prompt-file follow-up.txt \
  --idempotency-key '<stable-message-key>' --json
```

Submission/sending/waiting proposals require Phase 2 and actual server retry contracts. Export is an opt-in private transcript artifact. Any future `profiles create/update` or `settings rename` syntax must identify the approved field group and preview/effect; these examples do not authorize those writes.

## Test coverage assessment

Existing strengths: injectable HTTP/stdin/stdout/stderr/runner boundaries; path-segment escaping; config precedence and private file modes; cookie/error-query redaction checks; response size guards; parser/resource numerical bounds; fake API payload assertions; forwarding loopback, authority validation, concurrent token failures and shutdown tests. See [CLI tests](../../../packages/cli/internal/cli), especially `run_test.go`, `client_test.go`, `project_resolve_test.go`, `commands_test.go`, `workspace_test.go`.

Existing gaps:

- “Current contracts” JSON tests mostly assert array existence using hand-written minimal fixtures. Profile model/scope, pagination envelopes, actual nested project summary, full task detail, message sequence/tool metadata and notifications body/project are absent. `TestChatViewShowsMessages` supplies hasMore=false; incomplete transcript behavior is untested.
- No CLI flow tests traverse UI-equivalent resolve → submit → inspect → paginate → continue → answer → complete. Missing command families cannot have coverage just because Go lines are covered.
- No fixture validates ambiguous global/project profile choice, unknown explicit hint fallback, unknown/unsafe flag rejection, transport deadline, lost-response replay, or stdin prompt preservation.
- Module entrypoint has 0% coverage; doctor command emits a failed report with success exit, unlike a natural readiness probe. Keep forwarding tests, but do not mistake them for project-workflow parity.
- [CI](../../../.github/workflows/ci.yml#L796) runs CLI race/coverage and cross-build only when its CLI path filter fires; API/shared contract changes alone do not run CLI contract tests. [Sonar](../../../sonar-project.properties#L3) already receives Go coverage; this is not missing infrastructure.

No staging/deployment or live-write verification is appropriate for this audit. Future implementation should first use deterministic local Worker/HTTP fixtures matching actual handlers. Any live smoke requiring compute/settings/messages must be scoped and authorized separately with disposable resources and cleanup.

## Prioritized implementation proposal

Each phase should be a focused PR or small set of PRs. No all-endpoint wrapper, new agent framework, or speech engine is needed. Reuse existing APIs; only add server behavior where completeness, strict selection or retry safety requires it. The plan below is not authorization to start implementation.

### Phase 0 — Make existing commands truthful (P0/P1)

Consume the independent Attention fix; strict per-command flags/arity and useful contextual help; canonical discoverable task submit/get aliases sharing project resolution; explicit profile preflight/fail-closed server resolution; remove invalid-project status fallback; correct dashboard summary, project notifications, and complete JSON models. Add configurable HTTP deadline/cancellation and structured redacted errors. Keep no automatic write retries.

Acceptance:

- Every supported/unsupported flag and extra positional has deterministic behavior; unknown `--dry-run`, `--skill`, permission flags and misspelled selectors fail **before HTTP**. No fake dry-run or success for `profiles create` until implemented.
- Unknown explicit project/profile, stale default, duplicate/case-colliding names, inaccessible/global scope and valid agent-type-as-profile ambiguity are tested. Explicit requested Sol is never silently replaced. All-page project resolution does not skip later candidates.
- UI-shaped JSON fixtures preserve all promised fields and nulls; actual nested counters are shown correctly; project notifications include the project query. Errors have stable codes/status and no synthetic secret canaries in stdout/stderr/logs.
- Contextual help lists mutation/compute effects, full-ID input, JSON/error behavior, and all implemented submit flags. No auth needed for help. Human and JSON device auth do not corrupt machine output.
- Go race/coverage/vet, cross-build and relevant static analysis pass; audit observation tests become desired-behavior regression scenarios in the CLI suite. Independent fix tests remain owned by its PR.

### Phase 1 — Complete read-only inspection (P1)

Add task list/get/events/sessions, profile get/resolve, skills list/get/resolve, full session metadata/state/interactions inspection, exact message page controls, bounded transcript export and tool-content read. Add consistent pagination to projects/Ideas/library/context/notifications/activity. Settings inspection returns safe allowlisted metadata and effective config sources, not secret values.

Acceptance:

- `limit/cursor` or API-specific `offset/before/after` work; all continuation fields and total/hasMore remain visible. `--all-pages` differs from Library's current recursive `--all`; compatibility warning/documentation prevents conflation.
- Transcript test exceeds several pages, uses same-timestamp messages with sequence/id ties, reads both directions, includes tool/system/user messages and large pages near CLI byte limit. No duplicates or missing rows; archived unavailable and mid-page errors are explicit. Export says complete only for a bounded snapshot actually drained; concurrent appends/retention have defined behavior.
- Full-text JSON/NDJSON export is opt-in to stdout or output file; partial output/resume contract is documented. No automatic transcript logging, canary credentials absent in diagnostic errors, no prompt send/wake/provision on read.
- Scope and effective profile/skill layering include global/project, model/effort/runtime/permission sources; settings metadata masks all values by default, including supposedly non-secret runtime contents. Inaccessible fields are reported unavailable rather than fabricated null defaults.
- Local CLI-to-actual-Worker contract fixtures run on CLI **and API/shared schema** changes. Test API size caps, 401/403/404/409/429/5xx, cancellation and redacted non-JSON errors.

### Phase 2 — Reliable core work loop (P1)

Task/Idea create and approved metadata update; submit/linked Idea execution; task wait/watch; reachable session send/cancel/sleep; explicit fork/retry prompt preparation and launch; attention/interaction answers within the approved authority boundary. Add skill selection and prompt stdin/file; attachment support as a separate bounded increment. Implement server submission/prompt replay keys and receipt reconciliation before claiming safe retries.

Acceptance:

- A local integration scenario resolves SAM + Sol + optional skill, submits exactly once, preserves draft/no-merge prompt text, follows task/session links, drains transcript, sends an authorized follow-up once, surfaces a human interaction, observes final output, and returns a documented outcome exit. Task/conversation and VM/Instant selection match effective UI/API config.
- Drop the response after commit/acceptance; retry with same key returns same task/session/message receipt without duplicate work. Changed intent conflicts; expired/unknown receipts do not auto-resubmit. Cancellation/timeout after request can report unknown outcome for reconciliation.
- Idea execution matches current composer/link semantics, with original description/profile/skill and linked sessions; fork/retry adds exact lineage without LLM processing. Unsupported permission answers fail; human permission request remains pending and inspectable.
- Sleep preserves resumability; cancel only stops current turn; terminal archive/close is distinct, follows lifecycle guard and is deferred unless approved. `wait` timeout/cancelled/expired/failed have explicit semantics; mere queued receipt never says completed.
- Tests cover cross-project denial, creator restrictions, missing/stale original task/session, failed wake, busy queued prompt, JSON/text output, resource overrides and all input escaping. No production validation resources are used during development fixture tests.

### Phase 3 — Scoped profiles/skills and routine configuration (P1/P2, decisions required)

Profile/skill create/update/clone with full scoped preview and approved fields; optional routine project rename/description and chosen default. Do not expose raw API patch bodies. Keep runtime assets, policy/permission writes and spending knobs out unless separately approved.

Acceptance:

- Approved fields are enumerated in help and enforced; tests reject credential, GitHub rights, permissionMode, runtime files/MCP/spend fields even when nested or mixed with benign fields. Any promised authority restriction has backend enforcement, not only shell flags.
- Project/global target scope is explicit. Clone leaves shared source untouched; null clears override, omitted preserves, and effective inheritance is displayed. Name collision/case ambiguity and stale concurrent update do not overwrite unexpected state; introduce expectedVersion/conditional updates if current API cannot enforce that.
- Create lost-response retry is deduped or reconciled by immutable intent with a clear unknown-outcome result; duplicate names alone never count as successful replay. Delete remains distinct and separately approved.
- At minimum verify list → get → approved create → get effective → approved update → execute fixture with resulting profile/skill; tests demonstrate no mutation on preview, rejected fields, denied scope, cancelled confirmation or malformed input.

### Phase 4 — Remaining resource reads and explicitly chosen writes (P2)

Comments/inbox, remote Files and Library content first; Events channels/subscriptions/schedules/watches and trigger/deployment history/status next. Add only writes Raphael selects: e.g. notes/replies, library upload, trigger pause, schedules. Access, credentials, deployment launch/traffic, permission changes, destructive deletion and secret delivery are separate capability proposals, not an automatic final “parity” sweep.

Acceptance:

- Every operation's project/resource selectors, JSON/error shape, pagination, retries, confirmation and effect category are recorded in a small command contract table and tests. Read-only families work for viewer authority where existing server permits; writes fail on denied capability.
- Notes and send-to-agent are separate; existing comment mutation IDs reused. Schedules/watches use expectedVersion and creation keys; stale version, already-admitted cancellation and explicit retry effects are tested.
- Repo tree/compare truncation, binary/oversize content, artifact downloads and private deployment logs have truthful completeness/streaming/redaction contracts. Inspection never starts infrastructure.
- Optional automation/deployment/security writes require an approved scope, specific human intent/approval handling, safe secret handoff and operation-level audit/receipt evidence. No generic `--yes` bypass or broad `settings patch` endpoint exposure.

## Decisions needed from Raphael

1. **Settings boundaries:** accept read-only metadata/effective-config inspection first? Recommended. For routine writes, approve only rename/description initially, or also selecting an existing default profile? Model/effort/spend, runtime assets and permission fields remain separate.
2. **Profile/skill editing:** which fields may an assistant create/update without a per-action human approval—labels only, or agent/model/effort/prompt/limits? Recommend explicit field groups; clone rather than editing shared Sol by implication. Global profile edits require a separate choice.
3. **Consequential operations:** keep access/credential/billing/permissions/deployment/destructive writes UI-only initially (recommended), or later expose specific commands with human approval and server-enforced scopes? CLI support alone never grants assistant permission.
4. **Core lifecycle:** should assistant permission include send/cancel/sleep when explicitly requested? Recommend these as distinct commands; archive/close/delete and answering permission/auth prompts require separate explicit authorization.
5. **Automation:** should trigger pause/schedule creation be in the first write set? These alter future work/spend; do not classify them with rename. Standing watches deserve their own boundary.
6. **Transcript contract:** recommend bounded page reads by default and explicit complete snapshot export, with plain-text truncation warnings. Decide whether exports include hydrated archived tool bodies by default or an explicit opt-in (recommended opt-in).

Engineering details such as exact alias naming, parser helper structure, fixture mechanics and timeout implementation can be decided without another product approval. The decisions above are about capabilities and authority, not implementation busywork. Until those decisions are made, the review artifact is the deliverable and all write proposals remain unimplemented.
