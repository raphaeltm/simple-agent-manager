---
title: API Reference
description: SAM REST API endpoints for managing workspaces, nodes, and credentials.
---

The SAM API runs on a Cloudflare Worker at `api.{domain}`. All authenticated endpoints require a valid BetterAuth session cookie.

:::note
This reference covers the most commonly used endpoints. For the complete list of all API routes, see the [source code](https://github.com/raphaeltm/simple-agent-manager/tree/main/apps/api/src/routes).
:::

## Private SAM account assistant

These endpoints require an authenticated, approved account and resolve the `SamSession` Durable Object by that user's identity. Settings are off by default. Enabling is additionally subject to the installation kill switch; assistant turns and actions require both gates. No caller-supplied project ID selects the private conversation's owner.

| Method | Endpoint                              | Contract                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/sam/settings`                   | Returns `{ enabled, available }`; `enabled` is the saved user preference, `available` reflects installation availability.                                                                                                                                                                                                                                                                                  |
| PATCH  | `/api/sam/settings`                   | Body `{ enabled: boolean }`; returns the saved settings. Disabling fences further assistant effects and preserves history and already-dispatched project work.                                                                                                                                                                                                                                             |
| GET    | `/api/sam/turns`                      | Returns `{ conversationId, backingTaskId, legacyHistoryAvailable, turns, nextCursor, work }`. Pass the opaque `nextCursor` unchanged as `before` to load older turns. Each page is chronological; the first page contains the newest bounded window.                                                                                                                                                       |
| POST   | `/api/sam/fork`                       | Body `{ requestKey }`; returns `{ conversationId, backingTaskId, replayed }`. Creates and selects a private branch with copied user/assistant history and a new backing-task identity linked to its parent. Requires no active turn; retry the same key after a lost response. Does not copy project actions or grant project access. No fork button is exposed in the launch UI.                          |
| POST   | `/api/sam/turns`                      | Body `{ requestKey, message }`; returns `{ turn, accepted, replayed }`, with `202` for new acceptance or `200` for a replay. Reuse the same key and identical message after a lost response. Acceptance is not completion.                                                                                                                                                                                 |
| GET    | `/api/sam/turns/:id/stream`           | Server-sent events for the running turn: a `snapshot` (`phase`, `elapsedMs`, published `text`, one-line `thinking`, tool `activity`), then `phase`, `text` (`at` offset), `draft-reset`, `thinking`, `tool` and a final `done`. `204` when the turn is not running in the server object; `429` above the reader cap. Live text is only what passes the receipt guard; the stored turn stays authoritative. |
| POST   | `/api/sam/turns/:id/cancel`           | Stops an accepted/running assistant turn; returns `{ turn }`. This does not stop a project task already dispatched.                                                                                                                                                                                                                                                                                        |
| POST   | `/api/sam/actions/:id/confirm`        | Body `{ approved: boolean }`; approves or declines the exact stored action and returns `{ action }`. Repeating confirmation does not repeat its external effect.                                                                                                                                                                                                                                           |
| POST   | `/api/sam/actions/:id/reconcile`      | Checks the existing reservation for an uncertain `sam_chat_start` action; returns `{ action }`. This is reconciliation, not permission to dispatch replacement work.                                                                                                                                                                                                                                       |
| POST   | `/api/sam/updates/:id/seen`           | The ID is the dispatch action ID. Marks its retained event references communicated after current authorization checks; returns `{ seen: true }`. It does not answer an agent request.                                                                                                                                                                                                                      |
| GET    | `/api/sam/conversations`              | Lists retained private conversations.                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/api/sam/conversations/:id/messages` | Returns `{ messages, nextCursor }`; optional `limit` and `before` sequence cursor. Returns a chronological page from the newest remaining window. The assistant UI shows earlier history read-only and suppresses `operator:` message IDs already rendered as rich turns.                                                                                                                                  |

Turns include `id`, `request_key`, `message`, `state`, `response`, `error`, `actions` and `created_at`; the running turn also carries `live`, the same snapshot the stream sends first. Action receipts include `id`, `operation`, `input_json`, `state`, `result_json`, and optional `available`. Read-operation receipts project `input_json` as the string `"{}"` and `result_json` as `null`; retained resource payloads are not a visibility grant. A mutating action whose current resource access cannot be verified has `available: false`, redacted input, and an explanatory result; clients hide its confirmation controls. Treat `uncertain` as unresolved, not successful or safe to repeat. An explicit `rejectedBeforeEffects: true` error permits correcting the rejected input; absence of that flag does not prove that no effect occurred.

`work` contains authorized source task/session references, project/task labels, observed status and timestamp, attention flags, and coalesced unread update metadata. New events do not automatically generate assistant messages. Read transport acknowledgement and user-visible communication are separate records.

The old `POST /api/sam/chat` inference path is closed: enabled clients receive `409 client_update_required` and must use durable turns. See the [assistant guide](/docs/guides/sam-assistant/) for supported workflows and the [architecture decision](/docs/architecture/sam-account-assistant/) for ownership and recovery boundaries.

## MCP orchestration

Task agents can call `wait_for_subtasks` with a stable workflow-step `waitKey`, unique same-project task IDs, an optional `condition` of `all` (the default) or `any`, and an optional bounded `wakeAfterSeconds`. The agent must persist the workflow state and key before calling, reuse the key after a lost response, and end its turn after registration. ProjectData then reconciles selected task terminal state and durably wakes the same canonical caller session exactly once, including after session sleep and runtime replacement. Automatic wake prompts carry only trusted task IDs and statuses; agents fetch peer-authored output explicitly as untrusted data. Servers without durable prompt delivery reject registration so clients can use bounded foreground polling as a compatibility fallback.

Private feedback-project agents can also call `list_incident_queue`, `get_incident`, `claim_incident`, and `resolve_incident`. These tools are scoped server-side to the effective private feedback project setting (Admin → Integrations runtime value first, then `PLATFORM_FEEDBACK_PROJECT_ID` fallback); callers cannot provide a project id. `claim_incident` and `resolve_incident` require a task-scoped MCP token, use bounded leases/CAS tokens, and return only private redacted incident evidence labelled as untrusted. `resolve_incident` accepts structured ship-or-track fields for resolved outcomes: `fixPrUrl`, `dispatchedTaskId`, or `linkedRecordId`; rejected outcomes require a justification note instead.

Project eventing uses a pull loop over the canonical ProjectData `project_event_*` tables. Agents create a short-lived subscription with `create_project_event_subscription`, using v1 exact/set filters for `source`, `eventType`, `subjectType`, `subjectId`, and `severity`; recover existing subscriptions with `list_project_event_subscriptions`; inspect or cancel with `get_project_event_subscription` and `cancel_project_event_subscription`. Project, task, session, workspace, owner, and agent identity come from the verified MCP token, not tool arguments.

`dispatch_task` accepts modern VM workload input through `resourceRequirements` with optional `minVcpu`, `minMemoryGb`, `minDiskGb`, and `exclusiveNode`. Known numeric fields must be finite and non-negative; `exclusiveNode: false` is preserved. Deprecated `vmSize` remains accepted as a legacy compatibility hint and is not expanded into hardware by the client or MCP handler.

`dispatch_task` also accepts an optional `coordinationChannel`: an ordinary project event channel name (`agent-dm.` is reserved) shared by a feature's agents. When omitted, the child inherits the dispatching task's channel, so every descendant shares one channel; `retry_subtask` and session recovery copy it onto replacement tasks. The child's description gains a short "Coordination channel" section and `get_instructions` returns `task.coordinationChannel` with guidance. Channels stay project-visible, so this routes work and is not an access boundary. Implementation: `parseCoordinationChannelParam` in `apps/api/src/routes/mcp/dispatch-coordination-channel.ts`.

After subscribing, call `list_subscription_events` with the `subscriptionId` to replay missed or queued matches. The list response is payload-free: it returns summaries, delivery IDs, delivery state, `hasMore`, and an opaque `nextCursor` that is valid only for the same subscription. Call `get_event` only when a summary needs full stored event details, then call `ack_event_delivery` after processing each returned `deliveryId`; ack is idempotent. The pull tools themselves record matches, delivery decisions, and pull acknowledgements only — they do not steer runtimes, spawn tasks, or expose human/UI controls. Delivery happens out of band: `existing_session_prompt` and `runtime_interrupt` subscriptions wake the target chat through the durable prompt queue, and `runtime_interrupt` wakes carry the `interrupt` mailbox class, which may cancel an in-flight turn so the wake is delivered immediately.

## Event subscriptions

Project members with read access can inspect subscriptions. Members with task write access can cancel human or agent subscriptions. System, policy and standing-watch subscriptions must be managed through their owning controls.

| Method | Endpoint                                                                  | Purpose                                                       |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| GET    | `/api/projects/:projectId/event-subscriptions`                            | List subscriptions; optional `sessionId`, `state` and `limit` |
| GET    | `/api/projects/:projectId/event-subscriptions/:subscriptionId`            | Inspect one subscription                                      |
| GET    | `/api/projects/:projectId/event-subscriptions/:subscriptionId/deliveries` | Inspect bounded recent transport outcomes; optional `limit`   |
| POST   | `/api/projects/:projectId/event-subscriptions/:subscriptionId/cancel`     | Cancel with optional `{ "reason": "No longer needed" }`       |

The list defaults to active subscriptions and returns `{ subscriptions, hasMore }`. `state` accepts `active`, `cancelled`, `expired` or `any`. Results include ownership, target, requested and resolved delivery, expiry and cancellation details. Cancelling again is safe and reports `idempotent: true`; cancellation does not undo work an agent has already performed. The server derives the cancelling user's identity from the authenticated session.

Implementation: [`projectEventSubscriptionRoutes`](https://github.com/raphaeltm/simple-agent-manager/blob/main/apps/api/src/routes/project-event-subscriptions.ts) uses the existing project capability checks and canonical subscription cancellation.

## Agent event channels

Project members can browse channel activity with `GET /api/projects/:projectId/event-channels`
and read a channel with `GET /api/projects/:projectId/event-channels/:channel/history`.
Both require active membership with `task:read`. Each accepts `limit` and an optional
`cursor`; catalog responses return `nextCursor`, while history returns `cursor`,
`hasMore`, `watermark`, and `retentionGap`. Counts describe lifetime publications in
the current catalog generation, including events that retention has removed.

Agents use `publish_channel_event`, `list_event_channels`, `get_channel_history`,
`follow_event_channel`, and `catch_up_event_channel` through MCP. Publishing and
following require `task:write`; SAM verifies the calling task and derives its
project, user, chat and workspace identity. Messages are untrusted evidence.
They cannot override the reserved `sam.agent_channel` source or its event type.

To switch from history to live events, pass the consumed history cursor to
`follow_event_channel`, then call `catch_up_event_channel` until `hasMore` is false.
Read and acknowledge the resulting events with the ordinary subscription tools.
Concurrent publications are included through either catch-up or live matching.
Replaying a follow key retains the original watermark and deadline; a retention
gap or expired checkpoint requires a new explicit history/follow decision.
Omit the history cursor when only future events are wanted.
Following defaults to recording events. With `requestedDelivery: existing_session_prompt`,
follow and catch-up responses include the ordinary subscription checkpoint/end-turn
instructions and explain that a no-match expiry delivers no wake prompt.

Publishing the same message with the same key in the same chat/channel replays its
retained event. Reusing that key with different content reports a conflict.
Idempotency ends when event retention removes the record. Publication has a shared
per-project fixed-window rate limit; a boundary burst can span two windows.
Payload, fanout, channel cardinality and history page limits are configurable.
Empty idle catalog generations may be reclaimed, while live subscriptions continue
to follow the stable channel name.

A channel publication never matches the publisher's own `existing_session_prompt` or
`runtime_interrupt` subscription, live or through catch-up, so publishing never wakes
the publisher (`isSelfOriginatedChannelWake`). Record-only followers still see their
own publications in their pull feed. Channel names starting with `agent-dm.` are
reserved for SAM agent messaging and are rejected by `publish_channel_event`.

### Subscriber roster

Agents can inspect a channel's subscriber roster with `list_channel_subscribers(channel,state?,cursor?,limit?)`. It requires an active task-backed agent and existing project `task:read` access; the project comes from the verified token. Results include subscription ID, owner type/ID/name, target session/task/runtime/agent IDs, effective state, expiry and creation time across owners. The default `active` state excludes elapsed expiry even before cleanup; `cancelled`, `expired` and `any` are also supported. Every filter dimension must match a canonical channel publication (`sam.agent_channel`, `agent.channel.published`, subject type `agent_channel`, the channel name, severity `info`); omitted dimensions and matching exact/set values count. The roster includes broad subscriptions, not just explicit channel follows, and does not depend on the current channel catalog generation. This is filter eligibility; routing and wake rules still apply.

All matching and state filtering happens before the configured page limit. Continue `nextCursor` with the same channel and state until `hasMore` is false; the cursor is project/channel/state-bound and pages reflect current state rather than a frozen snapshot. No subscription reasons, private filters, idempotency keys, event payloads or delivery receipts are returned. A subscription does **not** prove that an agent read, acknowledged or acted on any message. Existing subscription get/cancel tools remain restricted to the caller's own subscriptions.

### Agent messages over shared channels

With `AGENT_MESSAGE_CHANNELS_ENABLED=true`, and only while event wakes and durable
prompt delivery are enabled, `send_durable_message` (classes `notify` and `deliver`)
and `send_message_to_subtask` stop injecting the sender's text into the recipient's
prompt. One ProjectData transaction (`sendAgentChannelMessage`) finds or creates the
canonical `agent-dm.<pair digest>` channel for the two chat sessions, ensures a
SAM-managed prompt-delivery subscription for each chat, and publishes the message
with its server-derived sender. The recipient is woken with a SAM-authored notice
that carries event IDs only; it reads the text with `get_event`
(`event.metadata.actor` is the verified sender), replies with `send_durable_message`,
and acknowledges with `ack_event_delivery`. Urgent classes keep stop-and-deliver.
Responses report `accepted: true, delivered: false` with `transport`, `channel`,
`eventId` and `sequence`; an optional `idempotencyKey` replays a lost-response retry,
and changed content under the same key is rejected as a conflict. Messages are capped
by `PROJECT_EVENT_CHANNEL_MESSAGE_MAX_BYTES` and pair channels by
`AGENT_MESSAGE_CHANNEL_MAX_CHANNELS`. Managed deployments enable the transport in `wrangler.toml`; the code fallback is off and `AGENT_MESSAGE_CHANNELS_ENABLED=false` selects the legacy path.

Pair-channel events match only subscriptions targeting one of the two participant
chats (`subscriptionCanMatchProjectEvent`), `follow_event_channel` rejects
`agent-dm.` names, and subscription idempotency keys starting with
`sam-agent-message:` are reserved, so other agents cannot be woken by a pair's
messages. History stays project-visible through `get_channel_history`. Managed
subscriptions may hold at most `AGENT_MESSAGE_MAX_ACTIVE_SUBSCRIPTIONS` of the
project's active-subscription cap; at that share SAM releases the least recently
matched idle pair subscriptions on other channels (the pair's next message recreates
them), and refuses the send with `outcome: "capacity"` (retryable) while every
candidate still owes a wake. Failed sends report `outcome` as `recipient_unavailable`
(the recipient's chat or authority is gone; not retryable), `conflict`, `capacity` or
`rejected`, and commit nothing. When a managed subscription exhausts its wake budget, its pending
wake remains deliverable while a replacement handles new messages. The drained old
subscription is retired after delivery.

## SAM Connector

The user-level MCP server that external AI apps use to act as a person; see
[Use SAM from Claude and ChatGPT](/docs/guides/sam-connector/). Paths are on the API host
(`https://api.<your-domain>`).

| Method         | Path                                                | Purpose                                                                     |
| -------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| any            | `/connect/mcp`                                      | MCP endpoint. Accepts an OAuth access token or a SAM API token as a bearer  |
| `GET`          | `/.well-known/oauth-protected-resource/connect/mcp` | Protected-resource metadata                                                 |
| `GET`          | `/.well-known/oauth-authorization-server`           | Authorization-server metadata                                               |
| `POST`         | `/oauth/register`                                   | Dynamic client registration                                                 |
| `GET`          | `/oauth/authorize`                                  | Starts authorization and sends the person to the web app's `/oauth/consent` |
| `POST`         | `/oauth/token`                                      | Code exchange and refresh                                                   |
| `POST`         | `/oauth/revoke`                                     | Token revocation                                                            |
| `GET`, `POST`  | `/api/connector/consent`                            | Consent preview and decision, used by the consent page                      |
| `GET`          | `/api/connector/settings`                           | `{ enabled, writeEnabled, url }` for the signed-in person                   |
| `GET`          | `/api/connector/connections`                        | The person's connected apps: `{ connections, nextCursor }`                  |
| `DELETE`       | `/api/connector/connections/:id`                    | Revoke one of the person's connections                                      |
| `GET`, `PATCH` | `/api/admin/connector/settings`                     | Superadmin settings; `PATCH` takes changed keys, and `null` resets a key    |
| `GET`          | `/api/admin/connector/connections`                  | Every person's connections                                                  |
| `DELETE`       | `/api/admin/connector/connections/:id`              | Revoke any connection                                                       |
| `GET`          | `/api/admin/connector/clients`                      | Registered clients: `{ clients, nextCursor }`                               |
| `PATCH`        | `/api/admin/connector/clients/:id`                  | `{ "blocked": true }` or `false`                                            |

Notes for client developers:

- Write tools take a `requestKey`. Reuse it when you retry, so a retry can't start work twice.
- Chat results show the newest message groups first. Pages count stored streaming rows; follow
  `nextCursor` for older content. A group split across pages carries `partialBefore` or
  `mayContinueInNewerPage`, and shortened summaries carry `truncated`.
- A task's final-message summary combines adjacent assistant fragments from a bounded recent window.
  During a long tool run that window can hold no assistant text, so the summary is `null`; read the
  chat for older progress.
- To answer an agent, send its `interactionId` with an `optionId`, `formContent`, or
  `decline: true`. A link request is accepted with `optionId: "accept"`. An attention question takes
  its `markerId` and an `answer` instead. SAM generates the receipt metadata.

## Authentication

### `POST /api/auth/sign-in/social`

Start GitHub OAuth flow. Redirects to GitHub for authorization.

### `POST /api/auth/sign-out`

End the current session.

### `GET /api/auth/session`

Returns the current authenticated session and user info.

## Workspaces

### `POST /api/workspaces`

Create a new workspace.

**Body:**

```json
{
  "installationId": "12345",
  "repository": "owner/repo",
  "branch": "main",
  "vmSize": "medium",
  "displayName": "My Workspace"
}
```

### `GET /api/workspaces`

List all workspaces for the authenticated user.

### `GET /api/workspaces/:id`

Get workspace details including status, node info, and URLs.

### `POST /api/workspaces/:id/stop`

Permanently stop a running workspace and delete any retained persistent-session snapshot. Use sleep when the same chat must be resumable.

### `POST /api/workspaces/:id/sleep`

Checkpoint the workspace's agent HOME, harness identity, exact Git checkout, and repository work in progress, verify the snapshot, and put the session to sleep. Git state includes the saved `HEAD`, branch or detached state, canonical upstream metadata, clean local-only commits, working tree, and index. VM compute is stopped only after SAM re-verifies the durable manifest and every artifact the manifest still claims. A complete snapshot restores and validates that state; if the saved Git state cannot be recreated, wake reports explicit degraded recovery instead of success on a different commit. Sleep requires a complete final snapshot (`verifyAndBeginSleepTeardown` in `apps/api/src/services/session-sleep-execution.ts`). If the final checkpoint is degraded, or stops reporting progress and is recorded as degraded, the sleep request fails and the workspace stays awake. SAM then retries automatically, within the bounded sleep-failure budget (`SESSION_SLEEP_FAILURE_MAX_ATTEMPTS`, `SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS`); after that an idle VM session may sleep on a Git recovery point instead ([SAM could not save a complete snapshot](/docs/guides/session-troubleshooting/#sam-could-not-save-a-complete-snapshot)). A session that already sleeps on an older degraded snapshot still wakes and reports the reduced restore state. Sending a follow-up in the same chat wakes the session during the seven-day retention window.

### `POST /api/workspaces/:id/restart`

Restart a stopped or errored workspace. Provisions a new VM and recreates the container. A
restart can cancel an unclaimed pending deletion, but returns `409` once a deletion attempt
has started or if the workspace identity changes before runtime recreation.

### `POST /api/workspaces/:id/rebuild`

Rebuild a running, recovering, or errored workspace on its assigned node. Returns `202` with
`{ "status": "rebuilding" }` after the exact workspace transition is claimed. Rebuild uses
the same deletion fence as restart: it cannot cancel or cross a deletion attempt that has
already started, and the VM request is refused if the workspace identity or status changes.

### `DELETE /api/workspaces/:id`

Permanently request deletion of a workspace, its retained session snapshot, and associated
resources. A confirmed deletion returns `200` with
`{ "success": true, "deletionStatus": "confirmed" }`. If VM deletion is not yet proven,
the endpoint returns `202` with
`{ "success": true, "deletionStatus": "pending", "workspaceStatus": "stopping", "reason": "..." }`.
The `202` response is not deletion proof: SAM keeps the workspace quarantined and retries from
durable state until VM absence/success or strict provider/container termination is confirmed.
The same `202` is returned for an idempotent repeat while that exact durable attempt is already
in flight, or when VM proof arrived but a concurrent state write requires terminalization to
converge on a later retry.
If the exact deletion target is missing, active, or reassigned before a durable attempt is
retained, the endpoint returns `409` with `deletionStatus: "rejected"`; it never labels that
rejection as a pending deletion.

### `GET /api/workspaces/:id/boot-log`

Get the provisioning progress log for a workspace.

## Agent Sessions

### `POST /api/workspaces/:id/agent-sessions`

Create a new agent session in a workspace. The agent (Claude Code, Codex, Gemini CLI, etc.) is determined by the selected agent profile.

### `GET /api/workspaces/:id/agent-sessions`

List active agent sessions for a workspace.

### `POST /api/workspaces/:id/agent-sessions/:sessionId/stop`

Stop a running agent session.

## Linked work

Project members can read context for an idea, chat, or library file:

| Method | Path                                                 | Response         |
| ------ | ---------------------------------------------------- | ---------------- |
| GET    | `/api/projects/:projectId/ideas/:ideaId/links`       | `IdeaContext`    |
| GET    | `/api/projects/:projectId/sessions/:sessionId/links` | `SessionContext` |
| GET    | `/api/projects/:projectId/library/:fileId/links`     | `FileContext`    |

Each context groups linked resources into capped lists with `items`, `total`, `truncated`, and `totalIsLowerBound`. The last field is true when a bounded PR read can only report a minimum count. Foreign and missing resources both return 404.

## Resource history

Retained CPU, memory, I/O, and out-of-memory observations for VM-backed workspaces. Requires project access. See [Session Resource History](/docs/guides/session-resources/) for how to read the values.

| Method | Endpoint                                                     | Purpose                            |
| ------ | ------------------------------------------------------------ | ---------------------------------- |
| GET    | `/api/projects/:id/sessions/:sessionId/resource-history`     | History scoped to one chat session |
| GET    | `/api/projects/:id/tasks/:taskId/resource-history`           | History scoped to one task         |
| GET    | `/api/projects/:id/workspaces/:workspaceId/resource-history` | History scoped to one workspace    |

All three return `{ summary, chunks }`, where `summary` carries the session's peaks, sample and gap counts, I/O totals, OOM count, and nullable `agentProfileId`, `skillId`, and `agentType` attribution. SAM resolves those attribution fields from server-owned records scoped to the same project and workspace; upload values cannot override them. `memoryWorkingSetMeanBytes` and `memoryWorkingSetPeakBytes` exclude reclaimable inactive file cache and are the sizing figures; they are `null` for history uploaded by older VM agents. `memoryMeanBytes`, `memoryPeakBytes`, and `memoryKernelPeakBytes` remain cache-inclusive for comparison. `chunks` is the index of retained time slices, newest first and capped at `WORKSPACE_RESOURCE_LIST_LIMIT` (24) with no cursor or offset — `?chunkId=` still resolves a chunk outside that window, but nothing enumerates the older IDs. Add `?chunkId=` to include a `detail` object with that chunk's samples and tool-correlation spans, downsampled to `WORKSPACE_RESOURCE_DETAIL_MAX_POINTS` (720) with spikes preserved. Each sample can include `memoryWorkingSetBytes`; when it is absent, that sample's working set is unknown rather than zero. Each `detail.toolSpans` entry may include an ACP `kind` and metadata-provided `toolName`; either can be absent in history from older VM agents. Tool names are capped by `WORKSPACE_RESOURCE_TOOL_NAME_MAX_BYTES` (256 by default).

Samples are workspace-cgroup observations, not per-process attribution. Stored payloads deliberately exclude prompts, tool-call titles, commands, tool inputs and arguments, tool output, file paths, environment values, and secrets; tool-call IDs are hashed. A tool name identifies the tool implementation, such as `Bash`, without exposing what it ran. Instant (Cloudflare Container) sessions have no resource history: the response is `200` with `summary: null` and an empty `chunks` array.

### Session timeline

The Resources drawer reads a whole chat session through two endpoints, both scoped to the project and session in the path.

| Method | Endpoint                                                                  | Purpose                                           |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------- |
| GET    | `/api/projects/:id/sessions/:sessionId/resource-timeline`                 | Every retained chunk of the session, with rollups |
| GET    | `/api/projects/:id/sessions/:sessionId/resource-timeline/chunks/:chunkId` | One chunk's 5-second samples and tool spans       |

The index returns `{ sessionId, runs, chunks, totalChunkCount, omittedChunkCount, maxChunks, collection, runtime }`. `chunks` is ascending by start time and covers every workspace the session ran on (each wake is a new workspace); each carries its `summary` and a columnar per-minute `rollup` (`null` for chunks uploaded before rollups existed). `runs` groups chunks by workspace with that workspace's `reservation` (`cpuMillis`, `memoryMb`, or `null`). Past `WORKSPACE_RESOURCE_TIMELINE_MAX_CHUNKS` (1000) the oldest chunks are left out and counted in `omittedChunkCount`. When there are no chunks, `collection` explains why: `unsupported` (an Instant session), `expired` (samples passed retention; the summary remains), or `pending` (nothing uploaded yet). The chunk endpoint returns the same shape as `detail` above and `404`s for a chunk that belongs to another project or session.

Agents read the same data with the `get_resource_history` MCP tool, which takes no `projectId` — the project comes from the verified token. With no arguments it returns the caller's own session; supplying any one of `sessionId`, `taskId`, or `workspaceId` replaces the caller's defaults entirely rather than narrowing within them.

### Agent requests

The permission requests, questions, and links an agent puts in a chat while it waits (see [When the Agent Needs You](/docs/guides/chat-features/#when-the-agent-needs-you)).

| Method | Endpoint                                                                   | Purpose                                            |
| ------ | -------------------------------------------------------------------------- | -------------------------------------------------- |
| GET    | `/api/projects/:id/sessions/:sessionId/interactions`                       | Pending and recently settled requests for the chat |
| GET    | `/api/projects/:id/sessions/:sessionId/interactions/:interactionId`        | One request's full detail (session writers only)   |
| POST   | `/api/projects/:id/sessions/:sessionId/interactions/:interactionId/answer` | Answer a pending request (session writers only)    |

The list returns `{ pending, settled, cursor }` and needs `task:read` on the project. Each item has the request's `interactionId`, `kind` (`permission`, `form`, or `url`), `state`, `createdAt`, and `deadlineAt`; for other project members that is all a pending item carries, and `settled` is empty — they never see the question or the answer. A _session writer_ is the session's creator or a member it is [shared with](#shared-chat-access). The detail is for session writers only, decrypted on request, and served with `Cache-Control: private, no-store`. Answering needs `task:write`, must come from the SAM web app's origin (the `Origin` header must match), and sends an `answerKey` with a `decision`: `{ kind: "selected_option", optionId }` for a permission, `{ kind: "accepted", content }` for a question (`content` holds the form's values) or `{ kind: "accepted" }` for a link, or `{ kind: "declined" }`. Each decision also carries an `answerHash`: the SHA-256 hex of the option ID, of the form values as key-sorted JSON, or of the word `accepted` or `declined`. Sending the same `answerKey` and decision again is safe; answering a request that was already answered or has expired returns `409`.

### Shared chat access

A chat's creator can give another project member the same controls in that one chat (see [Share a chat](/docs/guides/collaboration/#share-a-chat)). Every route that drives a chat — `POST .../prompt`, cancel, stop, archive, `POST .../comments/:threadId/send`, idle reset, answering agent requests, and the two below — accepts the creator or an active grantee, and returns `403` to other members. For a grantee, the server also requires that the grantee and the creator are both still active members with `task:write`; nothing else is checked. Grantee prompts must use durable delivery (`409` when it is off); their attachments must be the grantee's own uploads (`400` otherwise) and are copied only into the chat's workspace. Work still resolves resources and credentials as the session's creator; the grantee is recorded as the sender.

| Method | Endpoint                                                                      | Purpose                                               |
| ------ | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| GET    | `/api/projects/:id/sessions/:sessionId/access`                                | Who can drive the chat (any member with `task:read`)  |
| POST   | `/api/projects/:id/sessions/:sessionId/access/grants`                         | Share the chat with a member for a set time, or renew |
| DELETE | `/api/projects/:id/sessions/:sessionId/access/grants/:userId`                 | Revoke a member's access now, or leave                |
| POST   | `/api/projects/:id/sessions/:sessionId/sleep`                                 | Put the chat to sleep (session writers)               |
| POST   | `/api/projects/:id/sessions/:sessionId/agent-sessions/:agentSessionId/resume` | Resume the chat's agent (session writers)             |

`GET .../access` and `GET /api/projects/:id/sessions/:sessionId` return `viewerAccess` (`owner`, `grantee`, or `reader`) plus the owner, the active grants, `undelivered` and `serverTime` (the server's clock, so clients can show the time left). Each grant has `expiresAt` and `durationMinutes`. `undelivered` lists, newest first (at most 100), the messages cancelled before delivery because their sender's access ended, as `{ messageId, reason }` with `reason` `sender_access_revoked` or `sender_access_expired`; the message row carries the same label, and the list lets a client label a row it cached before the cancellation. `POST .../access/grants` takes `{ "userId": "...", "durationMinutes": 30, "acknowledgeSharedCredentials": true }`. `durationMinutes` must be `5`, `10`, `30` or `60`; there is no default. The acknowledgment is required because the chat runs on the creator's accounts. It returns `201` with the new grant. For someone who already has access it returns `200`: `renewed: true` when the creator renews (a new period from now), and `renewed: false` with nothing changed when anyone else shares again. A grant passed on by a grantee ends no later than theirs. The `access` summary in either response leaves out `undelivered`, so a client keeps the list from its last read. It returns `400` without a valid duration or the acknowledgment, for someone who is not an active member, the creator, or yourself, or when the chat has ended (only running or sleeping chats can be shared), and `409` above `collaboration.sessionAccessMaxGrants`. Access ends at `expiresAt` on every route above and before a queued prompt is delivered; prompts still queued then are cancelled. `DELETE` removes the grant and every grant that member issued, fails their prompts that have not reached the agent, and returns `{ revokedGrantIds, cancelledDeliveryIds, access }` (with `access.undelivered`). Anyone can delete their own grant.

Comment threads and replies accept an optional `mentions: [{ "userId": "..." }]`. The server keeps active project members only, stores each person's display name at the time, and returns `400` above `collaboration.commentMentionsMax`.

`GET /api/projects/:id/sessions/:sessionId/comments/:threadId/context` returns one comment thread with the chat around the message it is on, for [reading a comment in its conversation](/docs/guides/collaboration/#read-a-comment-in-its-conversation): `{ thread, session: { id, topic }, viewerAccess, anchor: { messageId, found }, messages, hasMoreBefore, hasMoreAfter }`. It needs `task:read`. `messages` is in transcript order and holds the whole commented message (an agent reply is stored as many streamed rows, and a comment can be on any of them) plus `collaboration.commentContextMessages` messages each side, reading at most `collaboration.commentContextMaxRows` rows each side. Page further with `GET .../sessions/:sessionId/messages` and `before`/`after` cursors from the first and last rows. When the commented message is no longer in the chat, `anchor.found` is `false` and `messages` is empty. A thread from another chat or another project returns `404`.

## Nodes

### `GET /api/nodes`

List all nodes for the authenticated user.

### `GET /api/nodes/:id`

Get node details including health status and hosted workspaces.

### `POST /api/nodes/:id/stop`

Stop a running node. All workspaces on the node must be stopped first.

### `DELETE /api/nodes/:id`

Delete a node and clean up DNS records and Hetzner resources.

## Credentials

### `POST /api/credentials`

Add or update a credential (cloud provider token or agent API key).

**Body:**

```json
{
  "provider": "hetzner",
  "credentialType": "cloud-provider",
  "token": "your-api-token"
}
```

### `GET /api/credentials`

List all credentials for the authenticated user (tokens are not returned).

### `DELETE /api/credentials/:provider`

Delete a stored cloud-provider credential.

### `GET /api/credentials/limits`

Latest provider usage windows for the authenticated user's personal credentials, across projects
(newest sample per credential and window). Each credential carries `credentialId` (for
`cc_credentials:<id>` references), `level` (`ok`, `warning`, `critical`, `rejected`) and its
`windows` (`windowType`, `utilizationPercent`, `windowMinutes`, `resetsAt`, `observedAt`, `source`).
Rows come from `credential_limit_windows`; the response is capped by `CREDENTIAL_LIMIT_READ_MAX_ROWS`.

### `GET /api/projects/:id/credential-limits`

Usage windows visible to the caller inside a project: the caller's own credentials plus project-
and platform-shared ones, never another member's personal credential. Requires `project:read`.
Optional `agentSessionId` narrows the result to the credential that agent session is attributed to,
resolved server-side from `agent_sessions`. The MCP tool `get_credential_limits` exposes the same
view to agents (`scope: "session" | "project"`). `credentialId` is filled in for the caller's own
credentials; a shared credential owned by another member whose reference is longer than 71 bytes
comes back with a `sha256:` digest as `credentialReference` and `credentialId: null`, with or
without `agentSessionId`.

### `GET /api/providers/catalog`

List non-secret compute-provider catalog metadata for cloud-provider credentials the caller can use.
The response includes provider-native instance offerings, locations, normalized resource metadata,
price metadata when available, and a `catalogSource` value such as `api` or `static`.

Optional query parameters:

| Parameter   | Values                            | Description                                                                                     |
| ----------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `scope`     | `user`, `project`, `installation` | Selects the credential scope to inspect. Omit it for the authenticated user's personal catalog. |
| `projectId` | Project ID                        | Required when `scope=project`; the caller must have the project `secret:read` capability.       |

Installation scope is restricted to superadmins and uses enabled platform compute credentials.
User scope uses the caller's active personal compute credentials. Project scope returns active
compute credentials attached to that project after project `secret:read` authorization, including
composable-credential attachments from other project members. Effective default pool summaries expose
project → user → installation fallback separately.

If no credentials are visible for the requested scope, the response still returns `catalogs: []`
with `credentialSetupRequired: true` and a `credentialSetupMessage` suitable for setup UI.

## Capacity pools

See the [Compute Pools guide](/docs/guides/compute-pools/) for what these concepts mean and how
they are surfaced in the app.

Default capacity-pool endpoints expose non-secret pool, source, and concrete candidate metadata.
Responses have this shape: `effective`, `effectiveScope`, `effectiveState`, `defaults`,
`precedence`, `reconciledScopes`, `policyMutationSupported`, and `placementSettings`. Each summary
includes `activeCandidateCount`, `availableCandidateCount`, `effectiveState`, and non-secret
diagnostics. `placementSettings` is a redacted settings contract containing the effective settings
fingerprint, selected source labels, selection weights, rollout percent, and normalized
`resourceDefaults.legacyWorkloadMapping` plus `resourceDefaults.platformDefaults`; it does not
include internal diagnostics or credential/source identifiers. Use `ensure=true` on GET endpoints,
or call the matching `/reconcile` endpoint, to refresh pool metadata from the credential-scoped
provider-native catalog. Provider API failures are reported in catalog refresh metadata and do not
synthesize static available rows for reconciliation. Provider catalog offerings expose
`catalogSource`; capacity-pool candidates expose the persisted `providerInstanceCatalogSource` and
`catalogAvailability` snapshot. `sourceGeneration` and `catalogGeneration` are refresh/fencing
epochs and may advance on identical reconciliations. `authorityGeneration` on sources and
candidates is a stable semantic authority value for the selected credential/source/offering state.
Placement snapshots persist `capacityAuthorityGeneration`; the legacy `sourceGeneration` snapshot
field is a compatibility alias for that same authority value, not the refresh epoch.

Only an unconfigured scope inherits from the next default-pool scope. A configured project or user
pool with state `configured-empty`, `source-disabled`, `catalog-unavailable`, or `migration-pending`
remains authoritative and is returned as `effective`; placement then queues/fails inside that pool
according to its exhaustion policy.

### `GET /api/capacity-pools/defaults`

Read the authenticated user's default compute pool. Optional `ensure=true` reconciles it from the
user's active personal compute credentials. The response includes `effectiveSummary`, a redacted
project/user/installation selection summary with no credential IDs or source metadata. Configured
zero-active or catalog-unavailable owned pools remain visible and are still selected as `effective`
so clients do not infer unsupported cross-scope fallback. Ordinary users may receive an
installation-funded `effectiveSummary` from existing installation metadata, but this endpoint never
reconciles installation credentials.

When the effective pool is ready, `effectiveSummary.nativeOfferings` lists its eligible VM
provider, location, native instance type, display name, resources and displayed price. These
choices omit pool, source, credential and owner identifiers. The Nodes creation form uses them
even when the user has no personal cloud credential. Empty, disabled or migrating effective
pools return no choices; they do not fall back to a personal credential catalog. Final node
creation still revalidates the selected offering against current pool authority.

### `POST /api/capacity-pools/defaults/reconcile`

Explicitly reconcile the authenticated user's default pool from active personal compute
credentials.

### `PATCH /api/capacity-pools/defaults`

Update the authenticated user's owned default-pool policy, candidate statuses, or provider-native
`catalogAdditions`. This endpoint does not mutate project or installation fallback pools.

`catalogAdditions` reactivates a currently available provider-native offering from the same
credential-scoped catalog used by reconciliation. It identifies the active source plus concrete
provider/location/instance type; it does not accept secret material:

```json
{
  "catalogAdditions": [
    {
      "sourceId": "cap-source-default:user:user-credential-id",
      "provider": "hetzner",
      "location": "fsn1",
      "providerInstanceType": "cpx62",
      "providerInstanceSku": null
    }
  ]
}
```

### `GET /api/projects/:id/capacity-pools/defaults`

Read a project's default pool context. Requires project `project:read`. All members receive
`effectiveSummary`, a redacted authoritative project → user → installation selection summary with no
credential IDs or source metadata. Raw project/user summaries require project `secret:read`; raw
installation details remain superadmin-only. Optional `ensure=true` reconciles only when the caller
also has project `secret:read`, and non-superadmins never reconcile installation credentials through
this route.

### `POST /api/projects/:id/capacity-pools/defaults/reconcile`

Explicitly reconcile visible default capacity-pool metadata from existing credentials in the project
context. Project-scoped metadata comes from active project compute credentials. Requires project
`secret:read`.

### `PATCH /api/projects/:id/capacity-pools/defaults`

Update only the project-owned default-pool policy, candidate statuses, or provider-native
`catalogAdditions`. Requires project `secret:write`.

### `GET /api/admin/capacity-pools/defaults`

Read the installation default pool. Superadmin only. Optional `ensure=true` reconciles enabled
platform compute credentials.

### `POST /api/admin/capacity-pools/defaults/reconcile`

Explicitly reconcile the installation default pool from enabled platform compute credentials.
Superadmin only.

### `PATCH /api/admin/capacity-pools/defaults`

Update only the installation-owned default-pool policy, candidate statuses, or provider-native
`catalogAdditions`. Superadmin only.

## GitHub

### `GET /api/github/installations`

List GitHub App installations for the authenticated user.

### `GET /api/github/repositories?installation_id=:id`

List repositories accessible through a GitHub App installation.

### `GET /api/github/callback`

Post-installation redirect handler. Records the installation and redirects to Settings.

## Projects

### `GET /api/projects`

List all projects for the authenticated user.

### `POST /api/projects`

Create a new project linked to a GitHub repository.

### `GET /api/projects/:id`

Get project details.

### `POST /api/projects/:id/tasks`

Create a task record.

**Body:**

```json
{
  "title": "Fix the login button"
}
```

## Ideas

An idea is something you want done that nobody has handed to an agent yet. These endpoints
return each idea's state **derived** from the work linked to it, never a stored label — see
[Idea Execution](/docs/guides/idea-execution/#ideas).

An idea is its own kind of row, marked as one when it is created. `POST /api/projects/:projectId/tasks`
creates an ordinary task, not an idea, even though that task starts out as a draft: a task you
have not dispatched yet does not appear in Ideas and cannot be marked done through these
endpoints. Ideas created before this distinction existed were all marked as ideas, so nothing
that was in your list has left it.

| Method | Endpoint                                           | Contract                                                                                                                                                                                                                                                                                                      |
| ------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:projectId/ideas`                   | Returns `{ items, truncated, totals }`. Each item carries `derived` (the state, its `source`, and the chat or pull request that decided it), `counts`, and a one-line `summary`. Open ideas and finished ones are capped separately, so a project that shipped a lot cannot push its open ideas off the page. |
| GET    | `/api/projects/:projectId/ideas/:ideaId`           | One idea: the current plan in full, its derived state, every chat linked to it and every pull request its work produced.                                                                                                                                                                                      |
| POST   | `/api/projects/:projectId/ideas`                   | Body `{ title, content? }`; files a new idea and returns it. Goes through the same operation the MCP `create_idea` tool uses.                                                                                                                                                                                 |
| POST   | `/api/projects/:projectId/ideas/:ideaId/status`    | Body `{ status: 'completed' \| 'cancelled' \| 'draft' }` — "Mark done", "Park", "Reopen". One transition table is shared with `update_idea` and the generic task status route, so every surface allows the same moves.                                                                                        |
| POST   | `/api/projects/:projectId/ideas/:ideaId/keep-open` | Records that a person answered the idea's "a pull request merged, is this done?" question with **Keep open**. Changes no status; the question simply stops being asked for that merge.                                                                                                                        |

Pull request state comes from what SAM has already stored for the project's pull requests. The
list never asks GitHub, because one page view would be one call per pull request in the project;
the single-idea read may ask for one bounded background refresh.

Counts can be minimums. Reading an idea's links is bounded per idea, so a very busy idea reports
`counts.atLeast` naming the counts it could only establish a floor for, and the UI writes those
as "50+" rather than a number it did not finish counting.

Reads require project membership; writes require the `task:write` capability. Every lookup is
scoped to the project in the query itself, so an idea from another project is reported as not
found rather than disclosed.

## Deployment Releases

### `POST /api/projects/:projectId/environments/:envId/releases`

Create a deployment release for an environment.

Preferred body: Docker Compose YAML with `Content-Type: text/yaml`, `application/yaml`, `text/x-yaml`, or `application/x-yaml`. Compose submissions may use `x-sam-routes` for routes and `x-sam-secret` environment values for secret references.

Raw manifest JSON is still accepted for backward compatibility when another content type is used.

### `GET /api/projects/:projectId/environments/:envId/releases`

List an environment's releases, newest first. Each release includes `submittedBy` — the `taskId`, `agentProfileId`, `workspaceId` and `userId` of the chat that sent it — or `null` when it was not sent by an agent. Optional `?limit=` (default 50, at most 200) caps how many releases come back.

### `GET /api/projects/:projectId/environments/:envId/releases/:releaseId`

Get one release, including its stored manifest.

### `GET /api/projects/:projectId/environments/:envId/releases/:releaseId/events`

The steps the deployment server reported while applying a release, oldest first: `{ "events": [{ "seq", "level", "eventType", "step", "message", "createdAt" }] }`. Each step reports `deployment.apply.<step>_started` and `…_completed`; a failure arrives as `deployment.apply.failed`. Optional `?limit=` (default 200, at most 500) returns the newest events.

### `POST /api/projects/:id/tasks/submit`

Submit an idea for autonomous execution. This is the chat-first path used by the web app; it creates the task, records the first message, and starts execution.

**Body:**

```json
{
  "message": "Fix the login button on the settings page",
  "resourceRequirements": {
    "minVcpu": 4,
    "minMemoryGb": 16,
    "exclusiveNode": false
  }
}
```

`resourceRequirements` is additive modern workload input. The API validates known fields and persists the normalized JSON through task launch inputs. Legacy `vmSize` is still accepted for old clients as a deprecated compatibility hint; clients should not infer provider hardware from it. Profiles, skills, and triggers persist the same modern data as `resourceRequirementsJson` for compatibility, with explicit `null` clearing that layer and omitted fields preserving inherited behavior.

Optional `sourceIdeaId` starts the work from an open idea in the same project. It is validated before anything is created — `404` for an id that is not an open idea in this project, `409` for an idea that is done or parked — and the session → idea link (`works_on` in task mode, `discusses` in conversation mode) is recorded before the agent receives its first prompt, on both the VM and the Instant path. If the link cannot be written the submit fails and the task is not left queued. Repeating the same start touches the same link rather than adding a second one. The idea is never injected into `message`; the agent receives it from `get_instructions`.

### `GET /api/projects/:id/agent-profiles/picker`

Returns the caller's own new-chat picker state for the project: `{ usage, hiddenProfileIds, usageWindowDays }`. `usage` lists `{ profileId, lastUsedAt, chatCount }` for profiles the caller started new chats with in the last `usageWindowDays` days (admin setting `chat.profileUsageWindowDays`, default 30), most recent first. Only chats the caller started by hand count; dispatched, triggered, recovered and idea drafts do not. Any active project member can read their own state.

### `PATCH /api/projects/:id/agent-profiles/picker`

Takes `{ "hide": ["<profileId>"], "unhide": ["<profileId>"] }` and returns `{ hiddenProfileIds }`. Hiding only removes a profile from the caller's own new-chat picker in this project; the profile, other members' pickers, triggers, dispatch and @mentions are unaffected. Only profiles the caller can use in the project can be hidden (`400` otherwise), and one profile cannot appear in both lists.

## File Proxy (Project Chat)

These endpoints proxy file operations to the workspace's VM agent, accessed through a project chat session.

The workspace's owner can use all of them. A member the chat is [shared with](/docs/guides/collaboration/#share-a-chat) can use the read endpoints (list, find, view, download, raw, git status and diff) while their access lasts; upload stays owner-only. For them every path must be relative to the repository working tree: absolute and `~` paths return `404` (a `.` or `..` segment returns `400` for everyone), and the VM agent refuses anything outside the working tree, inside a `.git` folder, or reached through a link that points outside it (`404`). If the workspace's agent cannot confirm that limit, the request returns `409` and nothing from the agent. Other members get `403`.

### `GET /api/projects/:id/sessions/:sessionId/files/list`

List files in a workspace directory.

### `GET /api/projects/:id/sessions/:sessionId/files/view`

View the contents of a file in the workspace.

### `POST /api/projects/:id/sessions/:sessionId/files/upload`

Upload files to the workspace container (multipart form data).

### `GET /api/projects/:id/sessions/:sessionId/files/download`

Download a file from the workspace container.

### `GET /api/projects/:id/sessions/:sessionId/files/raw`

Stream a binary file (images, etc.) with MIME detection and ETag support.

### `GET /api/projects/:id/sessions/:sessionId/git/status`

Get git status of the workspace repository.

### `GET /api/projects/:id/sessions/:sessionId/git/diff`

Get git diff output for the workspace repository.

## Terminal

### `POST /api/terminal/token`

Generate a short-lived JWT for WebSocket terminal access.

**Body:**

```json
{
  "workspaceId": "ws-abc123"
}
```

**Response:**

```json
{
  "token": "eyJhbG...",
  "expiresAt": 1730000000000,
  "workspaceUrl": "https://ws-abc123.example.com"
}
```

The client opens the terminal WebSocket at `wss://ws-abc123.example.com/terminal/ws/multi?token=...` using the returned token.

## Utility

### `GET /health`

Public health check endpoint. Returns `{ "status": "healthy", "timestamp": "..." }` (or `"degraded"` with a `503` when critical bindings are unavailable). No version or internal details are exposed.

### `GET /.well-known/jwks.json`

JSON Web Key Set for JWT verification by VM Agents.

### `GET /api/agent/download`

Download the VM Agent binary. Query params: `os` (linux), `arch` (amd64, arm64), and an optional `release` containing exactly 40 lowercase hexadecimal characters. Invalid releases return `400 INVALID_VERSION` before R2 is read. Official deployments use `release` so a new VM downloads the immutable binary selected by the live control plane; versioned responses use a one-year immutable cache policy. The unversioned URL retains its one-hour cache policy for legacy, local, manual, and intentional `skip_agent` deployments.

Used by cloud-init during VM (BYOC) provisioning. The Cloudflare Container instant-session runtime does **not** call this endpoint — its vm-agent binary is baked into the container image at deploy time.

### `POST /api/projects/:projectId/sessions/start`

Start an [Instant](/docs/guides/instant-sessions/) chat session. Returns **`202`** with `{ status: 'starting', runtime, taskId, sessionId, workspaceId, nodeId, workspaceUrl }` as soon as the records exist; the container launch, repository clone, agent start, and first prompt continue in the background, so a client disconnect no longer strands the session.

Because the launch is asynchronous, the response does **not** carry `agentSessionId`, `acpSessionId`, or launch `timings` — poll the session or connect to its stream for live state.

Optional `sourceIdeaId` behaves as it does on `POST /api/projects/:id/tasks/submit`, with the link recorded as `discusses`.

This endpoint is Instant-only. It returns `409` (`Selected profile resolves to VM runtime; use task submission instead.`) whenever the runtime resolves to VM — because the profile pins `vm`, because the caller has their own or a project cloud credential, or because `CF_CONTAINER_ENABLED` is not `true` for the deployment. Use `POST /api/projects/:id/tasks/submit` for VM work.

## Issue Reports

See [Reporting Issues](/docs/guides/reporting-issues/) for the user-facing flow and the operator configuration these endpoints depend on.

### `GET /api/report-issue/config`

Report whether in-app issue reporting is available on this deployment. Returns `{ "enabled": false }` when no effective private feedback project is configured, or when the effective setting does not name an existing project — the UI hides both entry points in that case.

### `POST /api/report-issue`

Submit an issue report. Returns `201` with the grouped incident's private draft Idea `ideaId`, its `status`, and `attachedRefKeys` listing the technical references that were actually stored. Repeated matching reports update the same grouped incident/Idea instead of creating one Idea per occurrence.

Body fields: `title`, `description`, `consentToAttachRefs`, and an optional `refs` object (`sessionId`, `taskId`, `nodeId`, `errorId`, `diagnosisId`). References are only stored when `consentToAttachRefs` is true, and each is re-checked against the caller's access first — unauthorized references are dropped silently rather than rejecting the request, so `attachedRefKeys` may be shorter than what was sent.

Rate-limited to 20 submissions per clock hour per user (`RATE_LIMIT_REPORT_ISSUE_POST`); exceeding it returns `429`.

### `POST /api/admin/observability/feedback-triage`

Superadmin only. Runs a platform-error triage sweep immediately instead of waiting for the hourly cron. The feedback project itself is configured from **Admin → Integrations** or the environment fallback; this endpoint remains the manual way to verify automated triage without waiting up to an hour.

## Admin Runtime Controls

These endpoints require an approved, authenticated **superadmin**. The switches
are availability brakes: an absent KV key or KV read error means enabled
(fail-open), so a transient KV outage does not silently halt recovery work.

### `GET /api/admin/runtime-controls`

Read the cron-sweep and Durable Object alarm switches. The response includes
`cronSweepsEnabled`, `doAlarmsEnabled`, the resolved KV keys, the in-memory
cache TTL, the disabled-alarm retry interval, and `semantics: "fail-open"`.

### `PATCH /api/admin/runtime-controls`

Update either or both switches. At least one field is required and every
provided value must be boolean.

```json
{
  "cronSweepsEnabled": false,
  "doAlarmsEnabled": false
}
```

Disabling the alarm switch does not drop alarm chains: each affected Durable
Object re-arms at the reported safe retry interval and resumes normally after
the switch is enabled again.

## Agent Email (preview)

Agent email is on when the deploy prepared Email Sending for `agents.<BASE_DOMAIN>` and a
superadmin then ran the setup below (see [Email Triggers](/docs/guides/email-triggers/)).

### `GET /api/config/agent-email`

Public. Returns `{ "enabled": boolean, "domain": string | null }`. `domain` is the domain agent
addresses live on, for example `agents.example.com`, and is `null` when agent email is off.

### `GET /api/admin/agent-email`

Superadmin only. Returns the same `enabled` and `domain`, plus `loopback`:
`{ lastSent: { to, sentAt, providerMessageId } | null, lastReceived: { from, subject, autoSubmitted, inReplyTo, receivedAt } | null }`.
`inReplyTo` is the Message-ID the reply answers, which ties it to one loopback test.
Loopback status expires after seven days.

### `GET /api/admin/agent-email/setup`

Superadmin only. Reads Cloudflare and returns what turning agent email on would do now:
`{ state, domain, mainDomain, mainDomainChanges, zoneChanges, consentToken, reason }`. `state` is
one of:

| `state`         | Meaning                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `unavailable`   | The deploy has not prepared agent email; `reason` says what is missing                                  |
| `verifying`     | Cloudflare is still verifying the sending records                                                       |
| `refused`       | The zone has never used Email Routing and the main domain has its own MX or SPF records                 |
| `changed`       | An earlier run left the main domain's MX or SPF records different from what it listed                   |
| `needs_consent` | Turning it on changes something outside `agents.<BASE_DOMAIN>`; the admin must allow the listed changes |
| `ready`         | Setup can run and changes nothing on the main domain or in the zone's Email Routing settings            |
| `on`            | Agent email is on                                                                                       |

Each `mainDomainChanges` entry is `{ type, name, content, priority?, change }`; `priority` is set
for MX records. In `needs_consent` they are the records Cloudflare adds the first time a zone uses
Email Routing (`content` is `null` for the DKIM key, which Cloudflare generates). In `changed` they
are the differences from the records the earlier run started from, `change: "add"` or
`"remove"`. `zoneChanges` lists zone settings the setup changes, today only
`{ setting: "subaddressing", description, allowed }` while subaddressing is off; `allowed` is true
when the admin allowed it for an earlier run that stopped before making it, which needs no new
consent. `consentToken` is set when the plan lists changes the admin has not allowed yet: it
identifies exactly the listed changes. Returns `502` with Cloudflare's error when a Cloudflare
call fails, or when Cloudflare lists only part of a name's records.

### `POST /api/admin/agent-email/setup`

Superadmin only. Body `{ "consentToken"?: string }`. Turns Email Routing on for
`agents.<BASE_DOMAIN>`, turns on subaddressing, routes `agent@agents.<BASE_DOMAIN>` to this Worker,
and records that agent email is on. When the plan lists changes, the body must carry that plan's
`consentToken`. Before it changes anything, the run stores the main domain's MX and SPF records
and takes a lease on the setup: one run at a time changes Cloudflare, and only the run holding the
lease can turn agent email on. Every later run compares the main domain against the stored
records. Returns
the resulting plan: `on`, or `pending` when Email Routing is on but its records are not visible
yet (run it again). Returns `409` when the plan is not `ready`, `needs_consent` or `changed`; when
the token is missing or belongs to a plan with other changes; when another run holds the lease or
starts at the same moment; when this run's lease lapses, stalls or is taken over before it finishes
(it stops before its next Cloudflare change, and agent email stays off); and when the main domain's
records changed beyond what was listed (agent email stays off, and the plan becomes `changed`). Returns `502` with Cloudflare's error when a Cloudflare call
fails, and `429` past the `agentEmail.setupRunsPerHour` limit. Running it again once on changes
nothing.

### `POST /api/admin/agent-email/loopback`

Superadmin only. Body `{ "to": "agent+<key>@agents.<BASE_DOMAIN>" }`. Sends one fixed test email
from `agent+loopback@agents.<BASE_DOMAIN>` to an existing email trigger and returns `202` with the
`lastSent` record. When that trigger's agent replies, the reply is routed back and recorded as
`lastReceived`. The trigger must list `agent+loopback@agents.<BASE_DOMAIN>` as an allowed sender.
Returns `409` when agent email is off, `400` for an address that is not an email trigger
address, `404` for an unknown trigger, and `429` past the `agentEmail.loopbackPerHour` limit.

## Admin AI Allowances

These endpoints require an approved, authenticated **superadmin**. An allowance caps what a user
may set as their own SAM-mode AI budget and, through `allowedModelTiers`, which budget tiers of
the platform model catalog they may use at all.

### `GET /api/admin/ai-allowance/:userId`

Read the stored allowance (or `null`) and the effective budget ceilings.

### `PUT /api/admin/ai-allowance/:userId`

Set or update fields; omitted fields keep their stored value.

```json
{
  "maxDailyInputTokens": 1000000,
  "maxDailyOutputTokens": null,
  "maxMonthlyCostCapUsd": 25,
  "allowedModelTiers": ["low-cost", "standard"]
}
```

`allowedModelTiers` is `null` (every tier) or an array drawn from `low-cost`, `standard` and
`premium`; any other value returns `400`, and `[]` allows no platform model. The AI proxy enforces
it on every route that spends platform credentials — `/ai/v1/chat/completions`,
`/ai/v1/responses`, `/ai/anthropic/v1/messages` and `/ai/anthropic/v1/messages/count_tokens` —
before the request reaches the upstream provider. A model outside the allowed tiers, or one the
platform catalog does not assign a tier, returns `403` with a `permission_error` naming the model
and the allowed tiers; an allowance the proxy cannot read is refused rather than treated as
unrestricted. BYO-key passthrough (`/ai/proxy/:wstoken/…`) is not restricted, because it spends the
user's own provider credential.

Before the tier check, each of those routes also requires the model to be on the operator's
allowlist, `AI_PROXY_ALLOWED_MODELS` (by default every model in the platform catalog), whether or
not the user has an allowance; any other model returns `400` with an `invalid_request_error`.
Allowances live in Workers KV, so a change can take a minute or more to reach every Cloudflare
location.

### `DELETE /api/admin/ai-allowance/:userId`

Remove the allowance; the user reverts to platform defaults and every tier.
