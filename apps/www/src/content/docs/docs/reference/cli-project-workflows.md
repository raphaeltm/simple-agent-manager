---
title: CLI project workflows
description: Inspect projects and perform scoped assistant workflows with explicit selection, JSON and safe work receipts.
---

Use `sam <family> --help` for the current command contract. Commands accept `--project <exact-name|unique-ID-prefix|full-ID>` and `--json`; prefer full project/resource IDs in scripts. Project and profile names must resolve unambiguously. An explicit profile such as Sol is never silently replaced by a default. `sam project use` changes only local CLI selection; it is unnecessary when every command has `--project`.

## Work loop

```bash
sam projects --all-pages --json
sam profiles list --project SAM --json
sam profiles resolve Sol --project SAM --json
sam skills list --project SAM --json
sam tasks submit --project SAM --agent-profile Sol \
  --prompt-file request.txt --idempotency-key voice-request-001 --json
sam tasks get <task-id> --project SAM --json
sam tasks sessions <task-id> --project SAM --json
sam chat messages <session-id> --project SAM --limit 100 --compact false --json
sam chat send <session-id> --project SAM --content-file followup.txt \
  --idempotency-key voice-followup-001 --json
sam tasks wait <task-id> --project SAM --timeout 30m --interval 2s --json
```

Submission returns a queued receipt, not completion. `tasks wait` exits 0 for completed work, 4 for failed/cancelled work, 3 when waiting times out, and 1 for command/API failures. A timeout stops waiting; it does not cancel the task. HTTP requests are individually bounded by `SAM_CLI_HTTP_TIMEOUT` (default `60s`). Interrupting the CLI cancels its local request/wait; it does not undo accepted work.

Prompt/content inputs accept positional text, `--prompt`/`--content`, a file, or stdin; choose exactly one. File/stdin input preserves prompt whitespace. `SAM_CLI_MAX_PROMPT_BYTES` can lower the 16,000-byte API ceiling. Use `--skill <exact-name-or-id>` to select an accessible skill; inspect `skills resolve <skill> [--profileId <profile-id>]` for server-computed layering. Submit resource overrides are explicit; help lists the supported flags. Per-dispatch `--model` remains reserved and fails; choose an existing configured profile instead.

## Receipts and retries

`--idempotency-key` on task submission, session send, and project profile/skill creation opts into a server receipt. Identical intent with the same key replays the original accepted identity. Changed intent conflicts. Keys are scoped to the authenticated actor, project, method and route and must contain 1–128 letters, digits, `.`, `_`, `:`, or `-`. The CLI never automatically retries a write.

```bash
sam tasks receipt --project SAM --key voice-request-001 --operation submit --json
sam tasks receipt --project SAM --key voice-followup-001 \
  --operation prompt --sessionId <session-id> --json
```

If a connection fails after sending a write, its outcome may be unknown. Inspect the receipt/task/session before using a new key. A pending receipt after an interrupted server execution remains reserved and cannot launch work again. `known: false` is not proof that resubmitting is safe. There is no expiry that turns an old key into permission to replay work. Receipts store intent hashes and successful responses, not request prompts. They do not guarantee recovery of every crashed execution; unknown outcomes require reconciliation.

Attachment uploads use `--attachment <local-file>` (repeatable) or `--attachment-ref-file <JSON-array-file>`. Local files must be nonempty, regular and at most `SAM_CLI_MAX_UPLOAD_BYTES` (default 50 MiB). Attachment reference JSON is bounded by `SAM_CLI_MAX_ATTACHMENT_REFERENCE_BYTES` (default 1 MiB). Presigned R2 requests receive no SAM cookie or authorization header. Re-uploading creates new attachment references and changes keyed intent: reuse the same reference file when retrying or inspect the work receipt first. Orphan uploads are not automatically attached to another task. Library upload likewise has no automatic replay: inspect Library after an unknown outcome.

## Transcripts and pagination

`sam chat <session-id>` displays one page and warns when earlier messages exist. It never promises a full transcript. JSON inspection preserves message sequence, origin, tool metadata, state, attention and `hasMore`. `chat messages` accepts `--before`, `--after`, `--order`, `--roles`, `--limit` and `--compact`; exact cursors are JSON arrays `[createdAt, sequence, id]`. Prefer these over timestamp-only cursors when messages have tied timestamps.

```bash
sam chat export <session-id> --project SAM --output transcript.json --json
sam chat export <session-id> --project SAM --ndjson --output transcript.ndjson
sam chat export <session-id> --project SAM --hydrate-tools --output transcript-with-tools.json
sam chat tool-content <session-id> <message-id> --project SAM --json
```

Export is an explicit private-data operation. It reads backwards from the newest observed message, excludes later appends, preserves all roles and uses exact cursors. It fails without publishing partial output when a page fails, makes no progress, duplicates messages, discloses skipped invalid rows, or exceeds `SAM_CLI_MAX_EXPORT_BYTES` (default 64 MiB). Output files are new files with mode `0600`; existing files are never overwritten. Export is buffered and printed/written only after the snapshot drains. NDJSON contains message rows; the normal JSON envelope contains completeness and snapshot metadata. Concurrent retention/deletion is not a transactional snapshot and can remove rows while exporting. Archived tool bodies are opt-in; `archived_unavailable` remains explicit rather than fabricated text.

`--all-pages` drains supported project/task/Idea/session/library/knowledge/notification lists. Other families expose their actual page controls and continuation metadata; unsupported `--all-pages` fails. Library's legacy `--all` means recursive directory listing, not all pages. Activity's timestamp-only cursor and comments inbox's bounded `hasMore` do not imply lossless full-history export. Task paging with alternate priority/updated sorting is rejected because the current API cursor is not a matching tuple cursor.

## Sidebar inspection

| Sidebar       | Commands                                                                                                  | Notes                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Chat          | `chat list/get/messages/export/tool-content/state/interactions/interaction`                               | Reads do not send, wake or provision.                                                               |
| Ideas/tasks   | `ideas list/get`, `tasks list/get/events/sessions/receipt/wait`                                           | Full JSON includes task/session links and outcomes.                                                 |
| Profiles      | `profiles list/get/resolve`                                                                               | Includes accessible project and global resources.                                                   |
| Skills        | `skills list/get/resolve`                                                                                 | Effective config comes from the server resolver.                                                    |
| Comments      | `comments list/session`                                                                                   | Session pages support sequence/message/status controls.                                             |
| Files         | `files branches/tree/get/compare/download`                                                                | Repository refs, not live workspace files; API truncation/binary metadata remains visible.          |
| Library       | `library list/get/directories/download`                                                                   | Download requires a new `--output` file; bounded by `SAM_CLI_MAX_DOWNLOAD_BYTES` (default 64 MiB).  |
| Agent Context | `context list/get/search`, `policies list/get`, `activity list`                                           | Instructions are read separately from granting authority.                                           |
| Notifications | `notifications list`                                                                                      | Explicitly filtered to the selected project.                                                        |
| Events        | `events subscriptions/subscription/deliveries/channels/history`, `schedules list/get`, `watches list/get` | Retention gaps and continuation fields stay visible.                                                |
| Triggers      | `triggers list/get/executions`                                                                            | Inspection does not run a trigger.                                                                  |
| Deployments   | `deployments list/get/releases/release/routes/containers/metrics`                                         | Inspection does not launch a release or change traffic.                                             |
| Settings      | `settings [get]`                                                                                          | Safe metadata, runtime asset metadata with every value/content masked, and config-resolution order. |

## Explicit effects and authority

| Command                                                  | Effect                                         | Boundary                                                                                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks create/update`, `ideas create/update`             | Draft/task metadata                            | Only title, description and priority.                                                                                                                                                                             |
| `ideas execute <id>`                                     | Prepares original Idea text and selectors      | `--launch` submits a conversation and links the Idea; an accepted receipt is preserved if linking fails.                                                                                                          |
| `chat fork/retry <id>`                                   | Prepares deterministic lineage/original prompt | `--launch` creates work. No LLM summary; retry reads the earliest user prompt forward.                                                                                                                            |
| `chat send`                                              | Sends follow-up work                           | Existing `task:write` and session-creator restrictions remain.                                                                                                                                                    |
| `chat cancel`                                            | Cancels current turn                           | Distinct from terminal session stop/archive/delete.                                                                                                                                                               |
| `chat sleep`                                             | Resumable workspace suspension                 | Refuses a session without a resumable workspace.                                                                                                                                                                  |
| `chat answer <session> <marker> --answer <exact-option>` | Answers current `needs_input` marker           | Offered options only; ACP permission/auth interactions remain human controlled and rejected by the existing server route.                                                                                         |
| `comments add/reply/resolve/reopen`                      | Notes/thread status                            | Existing `clientMutationId` supports replay; no send-to-agent side effect.                                                                                                                                        |
| `library upload`                                         | Creates project artifact                       | No automatic retry or destructive replace/delete.                                                                                                                                                                 |
| `profiles/skills create/update/clone`                    | Project metadata                               | Name/description only. Clone copies description into a newly named resource, reports `configurationCopied: false`, and leaves the source unchanged. It does not clone agent/security/spend/runtime configuration. |
| `settings update`                                        | Routine configuration                          | Project name/description only; server allowlist rejects mixed sensitive fields.                                                                                                                                   |

For notes, `comments add <session-id> <message-id>` and `comments reply <session-id> <thread-id>` accept exactly one of `--body`, `--body-file`, or `--body-stdin`. `comments resolve/reopen <session-id> <thread-id>` changes thread status. `--idempotency-key` maps to the note API's `clientMutationId`, rather than the work-receipt header. Trigger execution inspection uses `--limit`, `--offset`, and `--status`.

Routine metadata commands accept `--preview`. Profile/skill updates require a current version; `--expected-updated-at` can pin a reviewed version. A stale compare-and-set returns conflict rather than overwriting another edit. Global resources can be inspected and used as clone sources, but cannot be edited through project commands. Omitting a field preserves it; an empty description clears it to an empty string. The scoped API also supports an explicit JSON null description.

CLI capability is separate from assistant permission. A command being present does not authorize an assistant to execute it. Consequential settings, credentials, access/permissions, billing, spending limits, default profile changes, runtime files/MCP configuration, automation creation/pause, deployment/traffic changes, destructive deletion and permission/auth answers remain outside this rollout. There is no raw settings patch command or `--yes` authority bypass.

Errors exit nonzero and `--json` emits a JSON error on stderr with stable error code and HTTP status when available. Successful JSON uses stdout. Device-login instructions/progress do not mix with its stdout JSON result. Unknown flags, duplicate flags and invalid command arity fail before HTTP. Read commands do not implicitly send messages or start work. `runner doctor` exits nonzero when required checks fail; planned runner/harness commands still fail honestly.

An interrupted `tasks wait` returns exit `130` with `outcome: "wait_cancelled"`;
its overall deadline returns exit `3` with `outcome: "wait_timeout"`. Neither
outcome cancels the underlying task.
