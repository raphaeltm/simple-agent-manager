# Shared sessions: finish teammate controls

SAM task 01M59TN50JX53TPVXV0VTAN5JV (continuation), idea 01M59MYE4GY91BWTE8TZF1ZB5D. Follows PR #2381 (merged as `110730c2a`).

## Problem

PR #2381 shipped shared chats with 5/10/30/60-minute grants. It left terminal, files, git, ports, fork and attachments owner-only, and the final report marked them "Not done". The requirement is owner-equivalent control within the shared chat (Raph, 2026-10-19 09:27), under the same grant, expiry, revoke and attribution rules (Raph, 2026-10-19 13:55). The constraints: do not expose container-wide or account-wide resources, do not add new credential channels or persistent access, and do not treat a warning as resolving a new privilege escalation.

## Research findings (2026-10-20)

1. **Files/Git panels reach the whole container.** `resolveSessionWorkspace` (`apps/api/src/routes/projects/files.ts:53`) finds the workspace by `userId = caller`, so teammates get 404. Behind it, the VM agent's `sanitizeFilePath` (`packages/vm-agent/internal/server/git.go:329`) rejects only `..`. Absolute and `~` paths pass (the API's `normalizeFileProxyPath` allows them too). `files/list`, `files/raw`, `files/download` and `git/file` run `find`/`stat`/`cat` on the given path, and `git/diff` `cat`s untracked files, which follows symlinks. So the panel can read any file the container user can read, including the agent's sign-in files and other processes' environment. Requests are proxied per request through the API with a per-request token (`signTerminalToken`), and the VM agent's `Set-Cookie` is not forwarded, so per-request authorization is possible.
2. **Terminal** is a shell in the whole container. The browser holds a terminal token (`DEFAULT_TERMINAL_TOKEN_EXPIRY_MS` = 60 min) or a VM-agent workspace session cookie, which SAM cannot revoke, so Revoke now and the end time cannot cut a live shell. Commands are not recorded or attributed in the transcript.
3. **Ports**: the Worker proxies each request (`apps/api/src/index.ts:259`), but access rides a `sam_port_access` cookie (4 h default, signature-only check, not tied to a grant). WebSocket upgrades cannot be cut on revoke. Also, `expose_port` (`apps/api/src/routes/mcp/workspace-tools.ts:371`) returns a URL with an owner-signed `port_token`. If the agent posts that URL, every project member can read it (to verify).
4. **Fork**: the rail's Fork and Retry already submit a new task as the viewer (`useProjectChatState.ts:745`, `parentTaskId` + context) on the viewer's own accounts; G5 keeps the parent's personal attribution. The only owner-only fork is the archived-chat composer (`sourceSessionId` → `requireArchivedForkSource`, creator only). It applies only to tasks cancelled because their snapshot expired (`isExpiredTask`), which happens days after sleep. A grant lasts at most 60 min and cannot be added to an ended chat, so a teammate practically never holds a grant on such a chat. It restores no files.
5. **Attachments**: `sendChat` refuses a teammate's attachments. `transferPromptAttachments` (`apps/api/src/services/prompt-attachments.ts:23`) requires `senderId === workspace owner`. Uploads live under the uploader's R2 prefix (`buildAttachmentR2Key`). The adapter re-runs the sender fence immediately before transfer (`beforeTransfer`) and again before the send (`beforeExternalMutation`), in `apps/api/src/services/vm-prompt-delivery-adapter.ts:165`.
6. **Gap in #2381: schedules.** A `message_session` schedule (`packages/shared/src/types/project-event-schedules.ts:4`) can target any active or sleeping chat in the project. `requireScheduleAction` (`project-event-schedules-authority.ts:42`) checks only the creator's membership and the target task. It runs at creation, fire time (`project-event-schedules-runner.ts:464`) and recovery. The delivery sender fence covers only `user_followup`/`comment_directive`. So any member can queue prompts into another member's chat on that chat owner's accounts, and a teammate's schedule can fire after their grant ends.
7. Event subscriptions are self-targeted (identity from the MCP token), so they are not a cross-chat write path.

## Plan

Implement (session-scoped):

- [x] Schedules: a `message_session` schedule requires the creator to own the target chat or hold an active grant, at creation, fire time, recovery and before every delivery side effect; attribution on a teammate's scheduled prompt; a teammate's pending schedules for the chat are cancelled on revoke and expiry (commit `0250e906a`)
  - Reschedule and cancel stay open to any project writer, as documented before this work ("Project writers can change it", `scheduled-actions.md`, commit `4e69007c8`). A reschedule changes only the due and expiry times, never the target or the prompt, and the fire-time check still applies to the creator.
  - Only a person may use a grant (REST `creator: 'person'`); an agent (MCP) or SAM (provider-limit parking) may schedule only into its user's own chats.
  - A teammate's schedule records its grant (DO migration 066, `shared_access_grant_id`) and fires only under that grant; the delivery fence re-checks it before every side effect.
  - Standing watches outlive any grant, so they may only message chats their creator owns; only the creator may change a watch's action. The watch runner pauses a pre-existing watch into a chat its creator does not own.
  - Found while doing this: any maintainer could change another member's standing-watch action (a confused deputy). Closed by the creator-only rule above.
- [x] Attachments on a teammate's prompts: no refusal in `sendChat`; transfer reads the sender's own uploads into the owner's workspace only when the prompt is a shared-access prompt for that workspace's owner; the existing fence re-checks the grant before transfer and send (commit `9cc12b9fd`)
- [x] Files/Git panels for teammates, read-only, limited to the repository working tree:
  - [x] API: owner path unchanged; otherwise `requireSessionWriter` per request, relative paths only, a `confine=workdir` request, and the response must confirm the limit (`X-SAM-Path-Confinement: workdir`) or nothing is returned (older agents fail closed); upload stays owner-only; audit log per request (`file_proxy.shared_read`) — commits `a3718cbd1` (split), `f4c21abef`
  - [x] VM agent: when `confine=workdir`, reject absolute and `~` paths and resolve the real path (`realpath`, no flags, so busybox images work too) under the real working directory for `files/list`, `files/raw`, `files/download`, `git/file` (working-tree read) and the untracked `git/diff` fallback; read the resolved path; refuse `.git`; set the response header — commit `7305bc200`
  - [x] Web: Files and Git in the rail for teammates; the panel closes when access ends; the older-agent message comes from the API (409) — commit `d61b75a7d`
- [x] Share dialog and notice copy: what teammates can now do, and what stays owner-only (terminal, ports, workspace page) — commit `1169339e0`
- [x] Docs: collaboration guide, scheduled actions, chat features, security, API reference, API skill — commit `5aefd65cc`

Not implemented (reported for a decision, `tasks/backlog/2026-10-20-shared-chat-terminal-and-ports-decision.md`):

- Terminal (finding 2)
- Ports (finding 3)

No change needed:

- Fork (finding 4): teammates already fork and retry from the rail on their own accounts
- Workspace page (rebuild, stop, rename, terminal tabs): owner-only, not a chat surface

## Acceptance criteria

- [x] A member without a grant cannot create or fire a schedule that prompts someone else's chat (real-SQLite attack test with an owner control and a grantee control)
- [x] A teammate's schedule does not fire after their grant ends or is revoked, and their pending schedules for that chat are cancelled
- [x] A teammate's prompt with attachments delivers the files into the shared chat's workspace while the grant is active; after expiry or revoke, neither the files nor the prompt are delivered
- [x] A teammate can list, view, download and diff files inside the repository, and nothing outside it (absolute, `~`, `..`, symlinked file, symlinked directory, untracked symlink in git diff, any `.git`), on both runtimes (Go tests run every case standalone and through `docker exec`)
- [x] An agent that does not confirm the limit returns nothing to a teammate
- [x] Owner behaviour is unchanged, including legacy chats without a recorded creator
- [x] Expiry and revoke end each new surface on the next request
- [ ] Two-account staging covers each surface, including expiry and revoke

## Notes

- Guards proven discriminating (each removed once, the intended tests went red, restored):
  - Schedules (`tests/workers/shared-session-schedules.test.ts`, unit `project-schedules.test.ts`): agent grant use (2 red), no writer check (8 red), legacy owner fallback (1), fire-time grant binding (2), cascade schedule cancel (3), queued scheduled-message cancel (1), delivery fence (1), watch creator check (1), admission re-check (unit, 1), watch pause (unit, 1).
  - Attachments (`tests/workers/shared-session-attachments.test.ts`): old owner-only uploader rule (2 red), fence before each file (1), uploads read from the sender's prefix (2).
  - VM agent (`file_confinement_test.go`): no containment (all escape cases red), no `.git` exclusion (4), git diff fallback unresolved (1), confirmation header unset (all), git/file cat unresolved (5), relative-only pre-check (1).
  - API (`tests/workers/shared-session-files.test.ts`): no grant check (4 red), no confine param (2), no confirmation check (1), no absolute pre-check (1), no owner match for the linked workspace (1).
  - Web: Files gate owner-only again (1), panel stays open after access ends (1), scheduled message not attributed (2).
- Found and filed: a sub-folder listing includes the folder itself, for owners too (`tasks/backlog/2026-10-20-file-list-shows-folder-inside-itself.md`).
- Design decisions taken within the request (report them): teammates' agents (MCP) cannot use the teammate's grant to schedule; standing watches are owner-only (a lasting rule cannot be backed by a minutes-long grant); `.git` is excluded from teammates' Files reads; the Files limit does not stop the agent channel, which the share warning already covers.
- Mutation script lesson: restoring a mutated file with `git checkout` loses uncommitted edits; commit before mutating.
- Specialist review (2026-10-20), fixed in commits `85ead445a`, `632e8baa2`, `85033f04c`:
  - Security (PASS): a VM agent timeout logged the URL with its `?token=`; `fetchWithTimeout` now leaves the query string out (pre-existing, now also teammate traffic). `stat` gets `--`. `.env` is named in the share warning and the guide.
  - Go: nested `.git` directories are refused, not only the repository's; `..` answers 404 under confinement like every other escape; the `git/diff` untracked fallback answers a refused path with 404 instead of an empty diff; every confinement test runs on both runtimes, the VM one through `docker exec` with a docker CLI double.
  - Go raised the gap between the `realpath` check and the read (TOCTOU) as HIGH; the security reviewer rated it LOW. Decision: accepted and documented (code comment, `security.md`). Making the swap needs a process running in the workspace, and such a process can already read every file there; a teammate reaches one only through the agent, which the share warning covers and whose commands show in the chat. An atomic fd-based read would need a helper inside arbitrary images.
  - Test engineer: "reschedule/cancel by any writer" is documented behavior, not a new gap (see Plan). Listing every project schedule is likewise documented ("Project members can inspect automation"). Added: a standing watch paused through the real alarm, 304s under confinement.
  - UI: focus and an announcement when a teammate's panel closes; file links in messages gated like the rail; a failed download says why; the first share bullet split in two.
  - Cloudflare: the I/O comment now counts 8 round trips (at the rule-60 ceiling).
  - Each fix proven discriminating: timeout query (1 red), Git refusal wording (1), 304 order (1), watch pause via alarm (1), nested `.git` (3 tests), `..` 404 (2), sanitize mapping (1), diff fallback (1), `stat --` (1), devcontainer path really used (1), focus (1), announcement (1), file-link gate (1), download error (1), stale error on reopen (1).

- Staging is shared with the peer task 01M5B6WMMD6RV7Z737XSZCSBN9; message it before deploying.
