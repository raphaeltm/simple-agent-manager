# SAM CLI

The SAM CLI is a Go command-line client for SAM's existing control-plane APIs. It is designed as the foundation for a broader terminal surface that can eventually cover most app navigation actions while keeping remote SAM execution, local runner setup, and local harness execution distinct.

The implemented commands authenticate through interactive device flow, personal access tokens, or the legacy BetterAuth session-cookie path and call existing project task and chat routes. Local harness execution, runner installation, and runner registration are not implemented in this slice.

## Build From The Workspace

```bash
cd packages/cli
go test ./...
go build -o bin/sam ./cmd/sam
```

For deployment artifacts, use the package Makefile:

```bash
cd packages/cli
make build-all version
```

This writes Linux and macOS binaries for `amd64` and `arm64` to `packages/cli/bin/`, plus `version.json`. The staging and production deploy workflows upload those files to the deployment-owned R2 bucket under `cli/`, and the API serves them through:

- `GET /api/cli/version`
- `GET /api/cli/download?os=linux&arch=amd64`
- `GET /api/cli/download?os=linux&arch=arm64`
- `GET /api/cli/download?os=darwin&arch=amd64`
- `GET /api/cli/download?os=darwin&arch=arm64`

Users can download the CLI from the **Tools** page in the web app (`/tools/cli`), which auto-detects the user's OS and provides a one-click download button.

## Auth

Interactive browser login is the default CLI authentication flow:

```bash
sam auth login --api-url https://api.example.com
```

The CLI prints a verification URL and user code, opens the browser when possible, and polls until the request is approved in the web UI.

You can also create a personal access token from Settings -> API Tokens and exchange it for a CLI session:

```bash
sam auth login --api-url https://api.example.com --token sam_pat_...
```

The CLI writes `config.json` under `$SAM_CONFIG_DIR`, `$XDG_CONFIG_HOME/sam`, or `~/.config/sam` with file mode `0600` where the platform allows it. Normal status output redacts the session cookie:

```bash
sam auth status
```

For CI or short-lived shell use, avoid writing a config file and set an API token:

```bash
export SAM_API_URL=https://api.example.com
export SAM_API_TOKEN='sam_pat_...'
```

`SAM_API_TOKEN` requires `SAM_API_URL`. The CLI exchanges the token for a session cookie in memory before making authenticated API calls.

The legacy raw session-cookie path is still available for local debugging:

```bash
printf '%s' "$SAM_SESSION_COOKIE" | sam auth login \
  --api-url https://api.example.com \
  --session-cookie-stdin
```

`--session-cookie-stdin` avoids putting the cookie in shell history. `--session-cookie` is also available for local throwaway sessions. `SAM_SESSION_COOKIE` with `SAM_API_URL` is still supported for ephemeral automation, but personal access tokens are preferred.

## Commands

The CLI uses a hierarchical command structure. Most commands are project-scoped and use the active project set via `sam project use`, or accept `--project <name-or-id>` to override.

### Project Management

```bash
sam projects                    # List all projects
sam project use [<name-or-id>]  # Set active project (interactive picker if no arg)
sam project                     # Show active project details
sam status                      # Dashboard: project info + recent chats (falls back to project list if none set)
```

Project references accept a project name (case-insensitive), a short ULID prefix (5+ chars), or a full ULID. Full ULIDs are never required.

### Chat

```bash
sam chat                        # List chat sessions
sam chat new <message>          # Start a new conversation
sam chat <sessionId>            # View messages in a session
```

`sam chat new` calls `POST /api/projects/:projectId/tasks/submit` with `taskMode: "conversation"`. Options `--agent`, `--mode`, `--workspace`, and `--prompt` are supported.

### Project Resources (Read-Only)

```bash
sam ideas                       # List project ideas (draft tasks)
sam library                     # List library files
sam context                     # List project knowledge
sam notifications               # List notifications
sam triggers                    # List project triggers
sam profiles                    # List agent profiles
sam activity                    # List recent activity
```

### Infrastructure

```bash
sam nodes                       # List nodes across all projects
```

### Legacy Commands (Hidden From Help)

The old command vocabulary still works for backward compatibility but is hidden from `sam --help`:

```bash
sam task submit <projectId> <message>           # → use sam chat new
sam --project <id> tasks dispatch --prompt ...   # → use sam chat new
sam task status <projectId> <taskId>             # still functional
```

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
