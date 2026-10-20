---
title: Run commands with secrets
description: Why a variable you marked Secret shows up as a placeholder in your agent's workspace, and how the agent runs commands that need it with exec_with_secrets.
---

A variable you mark **Secret** is kept out of the agent's environment, so the agent can't print,
paste, or commit it by accident. When a command needs the value — a deploy, a database migration, a
call to a paid API — the agent runs that command with `exec_with_secrets`, which fills in only the
secrets it names, for that one command.

## What you'll see

In a workspace started on or after 14 October 2026 (on a self-hosted instance, v2026.10.14 or later),
a Secret variable holds a placeholder instead of its value, for example:

```text
__SAM_SECRET_REQUIRES_EXEC_WITH_SECRETS__STRIPE_KEY__
```

That's what the agent sees in its shell, and what you see in the workspace terminal on a VM. A
command that reads the variable directly gets the placeholder and fails to authenticate.

Nothing else changed: variables without **Secret** ticked keep their real values, and runtime files
(including secret file content), agent sign-ins, Git access, and [MCP servers](/docs/guides/mcp-servers/)
work as before. Chats that were already running when your instance updated keep their real values;
a new chat, or one that wakes from sleep, gets placeholders.

## Mark a variable as Secret

- **For a project:** **Settings → Runtime**, under **Environment Variables**. Enter the key and value,
  tick **Secret**, and add it. Project owners and admins can do this.
- **For a profile:** open the project's **Profiles**, edit the profile, and use **Runtime
  Environment**.
- **For a skill:** open **Skills**, edit the skill (after you've created it), and use **Runtime
  Environment**.

If the same name is set in more than one place, the skill's value wins over the profile's, and the
profile's over the project's. A name only counts as Secret if the value that wins is marked Secret.

## Ask the agent to run the command

Tell the agent which command needs which secret, for example:

> Run `npm run deploy` with `exec_with_secrets`, using the secret `STRIPE_KEY`.

The command runs in the same workspace, as the same user, with the same files and network — only the
named secrets are filled in. Any agent with SAM's tools can do this, on a VM or on
[Instant](/docs/guides/instant-sessions/). The result comes back when the command finishes, and
wherever a secret's exact value appears in the output, it's replaced with `[REDACTED]`. The chat
shows the command and the secret names, never the values.

A command can run for up to an hour (10 minutes unless the agent asks for longer), and up to 8 can
run at once on one machine. While one runs, the session counts as busy, so it won't go to sleep.

## What it doesn't cover

`exec_with_secrets` protects against accidents, not against the agent itself: the command can read
the values it's given, and a value written to a file, encoded, or transformed isn't redacted.

A program that reads the variable when it starts, outside `exec_with_secrets`, sees the
placeholder. That includes a dev server you start in the terminal, an MCP server from the
repository's own config, and hooks. Either start it through `exec_with_secrets` (its one-hour limit
applies), save the variable again under the same name with **Secret** unticked (SAM never shows a
secret's value, so enter it again; chats started after that can read it), or deliver the value as a
runtime file instead.

## Troubleshooting

- **"Secret execution unavailable: verify the active session, selected names and VM
  compatibility".** The name isn't a Secret variable for this project, profile, or skill; the chat
  started before your instance updated (start a new chat); or 8 commands are already running on
  that machine.
- **The agent won't start, with "managed secret … conflicts with harness environment
  authentication".** A Secret variable has the same name as the variable the agent's own connected
  credential is passed in, such as `ANTHROPIC_API_KEY`. Rename the variable or delete it.
- **"Managed environment contains an unsupported shell variable name".** A project, profile, or skill
  variable, Secret or not, is named `ENV`, `BASH_ENV`, `UID`, `EUID`, `PPID`, `SHELLOPTS`,
  `BASHOPTS`, or `BASH_VERSINFO`, so every `exec_with_secrets` call fails. Rename it.
- **The output says `environmentMode: legacy`.** The workspace's environment predates the Secret
  setting: it started before your instance updated, or the variable was added or marked Secret after
  it started. Start a new chat to get placeholders.

## Details for agents

`exec_with_secrets` takes either `argv` (a literal command, without shell expansion) or `command`
with an explicit `shell` of `bash` or `sh`, plus `secretNames`, an optional absolute `cwd`, an
optional `timeoutMs`, and an optional `idempotencyKey`:

```json
{
  "argv": ["python3", "deploy.py"],
  "secretNames": ["SERVICE_TOKEN"],
  "cwd": "/workspaces/my-project",
  "timeoutMs": 60000,
  "idempotencyKey": "deploy-attempt-1"
}
```

The call returns a job ID; poll `exec_with_secrets_status` until the result is final, and use
`exec_with_secrets_cancel` to stop a job (then poll until it reports the end). Reuse an idempotency
key only to retry the identical request. Output is kept to 64 KiB per stream, from the beginning.

Each job is a new non-interactive process: terminal exports, aliases, functions, activated
environments, and the terminal's current directory don't carry over, so source any setup the command
needs. Environment overrides are for non-secret values. `ENV`, `BASH_ENV`, `UID`, `EUID`, `PPID`,
`SHELLOPTS`, `BASHOPTS`, and `BASH_VERSINFO` can't be selected or overridden, and a managed variable
with one of these names makes every call fail. The container needs Bash and `setsid`; without them
the job fails rather than SAM replacing the container.

Cancelling stops the command's process group, but anything it started outside that group, such as
containers from `docker compose up -d`, keeps running. Stopping the session or workspace cancels its
jobs. If the VM agent stops, unfinished jobs end (`cancelled` after a clean shutdown, `interrupted`
after a crash) and are never re-run automatically.

Starting or restarting an agent fetches its environment from SAM each time. If that request fails,
the start fails and can be retried, rather than falling back to cached values that might hold real
secrets.
