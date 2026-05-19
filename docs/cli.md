# SAM CLI

The SAM CLI is an MVP terminal client for existing SAM APIs. It is intentionally thin: commands authenticate with the same BetterAuth session cookie used by the web app and call the existing project task and chat routes.

This first slice does not add personal access tokens, OAuth device flow, local harness execution, or MCP client behavior. Those are intended follow-ups once the terminal workflows are proven.

## Install From The Workspace

```bash
pnpm --filter @simple-agent-manager/cli build
pnpm --filter @simple-agent-manager/cli exec sam --help
```

## Auth

Configure the API origin and session cookie:

```bash
printf '%s' "$SAM_SESSION_COOKIE" | sam auth login \
  --api-url https://api.example.com \
  --session-cookie-stdin
```

`--session-cookie-stdin` avoids putting the cookie in shell history. `--session-cookie`
is also available for local throwaway sessions.

The CLI writes `config.json` under `$SAM_CONFIG_DIR`, `$XDG_CONFIG_HOME/sam`, or `~/.config/sam` with file mode `0600` where the platform allows it. Normal status output redacts the cookie:

```bash
sam auth status
```

For CI or short-lived shell use, avoid writing a config file and set both env vars:

```bash
export SAM_API_URL=https://api.example.com
export SAM_SESSION_COOKIE='better-auth.session_token=...'
```

`SAM_SESSION_COOKIE` requires `SAM_API_URL`. `SAM_API_URL` by itself does not replace
the stored config file.

## Submit A Task

```bash
sam task submit 01PROJECTID "Add a README section for the CLI"
```

Useful options map to the existing task submit request in `apps/api/src/routes/tasks/submit.ts`:

```bash
sam task submit 01PROJECTID "Run the migration safety audit" \
  --mode task \
  --workspace-profile full \
  --vm-size medium \
  --provider hetzner
```

## Check Task Status

```bash
sam task status 01PROJECTID 01TASKID
```

The command reads `GET /api/projects/:projectId/tasks/:taskId` and prints status, execution step, output branch, PR URL, finalization time, and any error message.

## Start Or Continue Chat

Start a conversation-mode run:

```bash
sam chat 01PROJECTID "Can you inspect the failing tests?"
```

Send a follow-up prompt to an existing session:

```bash
sam chat 01PROJECTID "Try the smaller repro first" --session 01SESSIONID
```

`sam chat` without `--session` submits through `POST /api/projects/:projectId/tasks/submit` with `taskMode: "conversation"`. `sam chat --session` calls `POST /api/projects/:projectId/sessions/:sessionId/prompt`.

## Machine-Readable Output

Add `--json` to commands that return structured data:

```bash
sam task status 01PROJECTID 01TASKID --json
```

## Security Notes

- Treat the session cookie as a bearer secret.
- Prefer environment variables for ephemeral automation.
- Do not commit CLI config files.
- This MVP reuses web session auth. A future PAT or device-flow implementation should have a lifecycle designed for long-lived CLI use.
