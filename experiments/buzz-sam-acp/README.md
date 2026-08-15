# Buzz ↔ SAM ACP throwaway prototype

> **Experimental and intentionally disposable.** This is a small proof that
> Buzz can treat a remote SAM conversation as an ACP agent. It is not the
> production `sam acp` design, is not part of `packages/cli`, and should not be
> used as a lifecycle/recovery design reference. Full context lives in SAM idea
> `01KZPTT49W10FC1P9G9RQEK8M1`.

The dependency-free Node executable and its small local modules speak ACP
JSON-RPC over stdio NDJSON to Buzz.
On the first Buzz prompt it submits a SAM task with `taskMode: "conversation"`;
later prompts and cancels use the SAM session HTTP endpoints. It polls persisted
SAM session state and assistant message rows, emits ACP message chunks, and
posts the completed reply with the **local** `buzz messages send` command. The
Buzz identity and private key never enter the SAM workspace.

## Deliberate shortcuts

These are boundaries of the prototype, not an implementation backlog for this
directory:

- **Turn boundaries are heuristic.** The script combines persisted session
  activity with a short message quiet window. A real implementation needs a
  robust, explicit, durable turn-completion signal.
- **Bindings are memory-only.** There is no channel → SAM session persistence,
  session resume/load, or transparent rebind. Restarting the harness loses its
  bindings and creates a new SAM conversation on the next prompt. Within one
  process, the bridge rejects a channel change instead of silently crossing
  channel boundaries.
- **Runtime loss is terminal here.** If the VM-backed SAM session dies, the turn
  fails loudly. The real design needs runtime-neutral dormant resume that
  restores each harness's native files plus git WIP; replaying ProjectData chat
  text is not equivalent to restoring harness state.
- **Fork is intentionally absent.** Exact resume should be primary. Fork should
  remain available for deliberate branching and only as an honest degradation
  fallback when restoration is impossible or its retained bundle has expired.
- **No runtime error taxonomy.** The prototype does not guess whether an opaque
  VM/cf-container error is transient or terminal.
- **Reply-only Buzz capability.** The local bridge posts the final text, so the
  remote SAM agent cannot use Buzz tools for PRs, issues, canvas, or reactions.
  Delegating the Buzz identity is a separate trust/capability decision.

## Setup

Requirements: Node 20+, the current SAM CLI, the Buzz CLI on `PATH`, and Buzz
Desktop.

Use a **private, single-user demo channel** and a dedicated least-privilege SAM
project/profile. Anyone who can invoke this harness in its Buzz channel can
exercise the configured SAM session-cookie authority and should be treated as a
SAM operator. This prototype is not a multi-user authorization boundary.

1. Authenticate and find the IDs to bind:

   ```bash
   sam auth login
   sam projects --json
   sam project use <full-project-id>
   sam profiles --json
   ```

   `sam auth login` writes the cookie this script reuses at
   `~/.config/sam/config.json` (or the current `SAM_CONFIG_DIR` /
   `XDG_CONFIG_HOME` location).

2. Copy [`harness-definition.json`](./harness-definition.json) into Buzz's
   `<app-data>/custom_harnesses/` directory (or enter the same fields in Buzz's
   custom-harness UI). Edit the absolute script path, `SAM_PROJECT_ID`, and
   `SAM_AGENT_PROFILE_ID` placeholders. The profile supplies the SAM agent,
   model, and settings. The current `/tasks/submit` path used by this spike is
   VM-backed; this prototype does not select or abstract VM/Instant runtimes.

3. Refresh Buzz's harness catalog, create a managed agent using **SAM ACP
   prototype**, add it to a channel, and mention it. Keep Buzz Desktop and this
   local harness process alive for the demo.

For a direct transcript test outside Buzz:

```bash
SAM_PROJECT_ID=<project-id> \
SAM_AGENT_PROFILE_ID=<profile-id> \
node experiments/buzz-sam-acp/buzz-sam-acp.mjs
```

Then write one JSON-RPC object per line. In ordinary use Buzz owns this stdio
connection.

## Configuration

Required:

- `SAM_PROJECT_ID` — exact SAM project ID.
- `SAM_AGENT_PROFILE_ID` — exact project/builtin profile ID.

Authentication defaults to the current SAM CLI config. For an isolated test,
`SAM_API_URL` and `SAM_SESSION_COOKIE` may be set together. Other optional
prototype knobs are `BUZZ_CLI`, `SAM_ACP_POLL_MS`, `SAM_ACP_SETTLE_MS`,
`SAM_ACP_TURN_TIMEOUT_MS`, `SAM_ACP_HTTP_TIMEOUT_MS`,
`SAM_ACP_KEEPALIVE_MS`, `SAM_ACP_TASK_CHECK_MS`, `SAM_ACP_MESSAGE_LIMIT`,
`SAM_ACP_ERROR_BODY_LIMIT`, `SAM_ACP_BUZZ_STDERR_LIMIT`, and
`SAM_ACP_BUZZ_TIMEOUT_MS`.

The bridge gives the local Buzz CLI only `BUZZ_*` variables plus the small set
of OS path, home, temporary-directory, and locale variables needed to launch a
local executable. SAM, provider, cloud, and GitHub credentials are not inherited.
That is defense in depth, not a substitute for the single-user/least-privilege
restriction above. The Buzz CLI call also has a bounded timeout and is killed
before a timeout error is returned.

## Local validation

No staging deployment is needed or intended. Run:

```bash
node --check experiments/buzz-sam-acp/buzz-sam-acp.mjs
node --check experiments/buzz-sam-acp/configuration.mjs
node --check experiments/buzz-sam-acp/sam-api.mjs
node --check experiments/buzz-sam-acp/buzz-cli.mjs
node --check experiments/buzz-sam-acp/smoke-test.mjs
node experiments/buzz-sam-acp/smoke-test.mjs
```

The smoke test starts a local fake SAM server and fake Buzz CLI, then exercises
initialize, session/new, first and follow-up prompts, persisted assistant
chunks, local Buzz posting, child-process credential isolation and timeout
cleanup, and cancellation.
