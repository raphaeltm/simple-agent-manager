# SAM CLI

The SAM CLI is a Go command-line client for SAM's existing control-plane APIs. It is designed as the foundation for a broader terminal surface that can eventually cover most app navigation actions while keeping remote SAM execution, local runner setup, and local harness execution distinct.

The implemented commands authenticate with the same BetterAuth session cookie used by the web app and call existing project task and chat routes. Personal access tokens, OAuth device flow, local harness execution, runner installation, and runner registration are not implemented in this slice.

## Build From The Workspace

```bash
cd packages/cli
go test ./...
go build -o bin/sam ./cmd/sam
```

## Auth

Configure the API origin and session cookie:

```bash
printf '%s' "$SAM_SESSION_COOKIE" | sam auth login \
  --api-url https://api.example.com \
  --session-cookie-stdin
```

`--session-cookie-stdin` avoids putting the cookie in shell history. `--session-cookie` is also available for local throwaway sessions.

The CLI writes `config.json` under `$SAM_CONFIG_DIR`, `$XDG_CONFIG_HOME/sam`, or `~/.config/sam` with file mode `0600` where the platform allows it. Normal status output redacts the cookie:

```bash
sam auth status
```

For CI or short-lived shell use, avoid writing a config file and set both env vars:

```bash
export SAM_API_URL=https://api.example.com
export SAM_SESSION_COOKIE='better-auth.session_token=...'
```

`SAM_SESSION_COOKIE` requires `SAM_API_URL`. `SAM_API_URL` by itself does not replace the stored config file.

## Dispatch A Task

The forward-looking command vocabulary is `tasks dispatch`, scoped with `--project`:

```bash
sam --project 01PROJECTID tasks dispatch \
  --agent sam \
  --mode task \
  --workspace lightweight \
  --prompt "manage the development of idea 123DSFD8902"
```

This calls `POST /api/projects/:projectId/tasks/submit`. Options map to fields that the current submit API already accepts. The CLI does not invent runner or harness behavior behind this command.

`--model` is reserved for the command shape Raphaël described, but the current submit API does not accept a per-dispatch model field. For this slice, model selection should flow through `--agent-profile` until the server API supports an explicit model override.

Compatibility command:

```bash
sam task submit 01PROJECTID "Add a README section for the CLI"
sam --project 01PROJECTID task submit "Add a README section for the CLI"
```

## Check Task Status

```bash
sam task status 01PROJECTID 01TASKID
sam --project 01PROJECTID task status 01TASKID
```

The command reads `GET /api/projects/:projectId/tasks/:taskId` and prints status, execution step, output branch, PR URL, finalization time, and any error message.

## Start Or Continue Chat

Start a conversation-mode run:

```bash
sam --project 01PROJECTID chat "Can you inspect the failing tests?"
```

Send a follow-up prompt to an existing session:

```bash
sam --project 01PROJECTID chat --session 01SESSIONID "Try the smaller repro first"
```

`sam chat` without `--session` submits through `POST /api/projects/:projectId/tasks/submit` with `taskMode: "conversation"`. `sam chat --session` calls `POST /api/projects/:projectId/sessions/:sessionId/prompt`.

## Runner Preflight

`runner doctor` is a read-only host preflight for future user-registered SAM runners:

```bash
sam runner doctor
```

It checks the OS, architecture, Docker CLI, Docker daemon, systemd availability, and whether `vm-agent` is already on `PATH`. It does not install packages, register the machine, create a node, or write service files.

The following commands are reserved but intentionally fail until their API and credential lifecycle contracts exist:

```bash
sam runner install
sam runner register
```

## Harness Roadmap

The Go CLI is intentionally compatible with future native harness integration, but local harness execution is not implemented yet. The `sam harness` namespace is reserved and currently reports planned-command messaging instead of pretending the feature works.

Remote task dispatch and local harness execution should remain explicit command paths.

## Machine-Readable Output

Add `--json` to commands that return structured data:

```bash
sam --project 01PROJECTID task status 01TASKID --json
sam runner doctor --json
```

## Security Notes

- Treat the session cookie as a bearer secret.
- Prefer environment variables for ephemeral automation.
- Do not commit CLI config files.
- This CLI reuses web session auth. A future PAT or device-flow implementation should have a lifecycle designed for long-lived CLI use.
- Runner registration will need a real node credential and callback-token renewal design before it is safe to ship.
