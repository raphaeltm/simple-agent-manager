---
title: Run commands with secrets
description: Why a variable you marked Secret shows up as a placeholder in your agent's workspace, how the agent runs commands that need it with exec_with_secrets, and how an agent can ask you for a secret without it entering the chat.
---

A variable you mark **Secret** is kept out of the agent's environment, so the agent can't print,
paste, or commit it by accident. When a command needs the value (a deploy, a database migration, a
call to a paid API), the agent runs that command with `exec_with_secrets`, which fills in only the
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
(including secret file content), agent sign-ins, Git access, and the
[MCP servers you add in SAM](/docs/guides/mcp-servers/) work as before. Chats that were already running when your instance updated keep their real values;
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

## Let the agent ask you for a secret

When an agent needs a key you haven't stored yet, it can ask for it with the `request_secret` tool
instead of asking you to paste it into the chat. A **Secret requested** card appears in the
conversation with the variable name, the agent's reason, and how long the value will be kept. You
also get a **Secret requested** notification.

1. Type or paste the value into the card and select **Save secret**. If the name already exists in
   the project, tick **Replace the existing value** first.
2. SAM stores it encrypted as a project **Secret** variable and tells the agent, by name only, that
   it's ready. The agent can use it with `exec_with_secrets` straight away, without restarting.
3. Or select **Decline**, and the agent is told not to wait for it.

The value goes from the card to SAM directly. It is never sent to the agent, written into the chat,
or included in the agent's tool results or notices.

What to know:

- **Who can answer.** Project owners and admins (the people who can edit project secrets). A
  maintainer sees the card and its status but not the input.
- **Who can use it.** It is a project secret, so every project member's agent sessions can use it,
  like one you add in **Settings → Runtime**.
- **Expiry.** The agent can ask for the value to expire, for example after an hour. After that,
  `exec_with_secrets` refuses it and agents no longer see it; it shows as **expired** in
  **Settings → Runtime** until a daily cleanup deletes it. Expiry can't take back a value a command
  already received while it was valid.
- **Open requests expire too.** A request nobody answers closes after a day by default, and the agent
  is told. Asking again for the same name in the same chat shows the open card rather than a new one.
- **Where it came from.** In **Settings → Runtime**, values supplied this way carry a **collected**
  badge with who supplied them, when, the agent's reason, and a link to the chat. Delete or replace
  them there like any other variable; replacing one by hand makes it an ordinary, non-expiring value.
- **Names a profile or skill already sets** can't be requested: the profile or skill value would win,
  so the agent is told to use that one or pick another name.

An administrator can change how long requests stay open, the shortest and longest expiry an agent can
ask for, how many open requests one chat may have, and how long finished requests are kept, in
**Admin → Settings** under **Chat** (see [Admin settings](/docs/guides/admin-settings/#chat)).

## Ask the agent to run the command

Tell the agent which command needs which secret, for example:

> Run `npm run deploy` with `exec_with_secrets`, using the secret `STRIPE_KEY`.

The command runs in the same workspace, as the same user, with the same files and network; only the
named secrets are filled in. Any agent with SAM's tools can do this, on a VM or on
[Instant](/docs/guides/instant-sessions/). The result comes back when the command finishes, and
wherever a secret's exact value appears in the output, it's replaced with `[REDACTED]`. The chat
shows the command and the secret names, never the values.

By default a command can run for up to an hour (10 minutes unless the agent asks for longer), and up
to 8 can run at once on one machine. An operator can change these with `SECRET_EXEC_TIMEOUT_MS`,
`SECRET_EXEC_MAX_TIMEOUT_MS` and `SECRET_EXEC_MAX_ACTIVE` (see
[VM agent configuration](/docs/reference/vm-agent/#configuration)). While one runs, the session counts as busy, so it won't go to sleep.

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
  started before your instance updated (start a new chat); or the most commands allowed at once
  (8 by default) are already running on that machine.
- **The agent won't start, with "managed secret … conflicts with harness environment
  authentication".** A Secret variable has the same name as the variable the agent's own connected
  credential is passed in, such as `ANTHROPIC_API_KEY`. Rename the variable or delete it.
- **"Managed environment contains an unsupported shell variable name".** A project, profile, or skill
  variable, Secret or not, is named `ENV`, `BASH_ENV`, `UID`, `EUID`, `PPID`, `SHELLOPTS`,
  `BASHOPTS`, `BASH_VERSINFO` or `SAM_OIDC_TOKEN`, so every `exec_with_secrets` call fails. Rename
  it.
- **The output says `environmentMode: legacy`.** The workspace's environment predates the Secret
  setting: it started before your instance updated, or the variable was added or marked Secret after
  it started. Start a new chat, or, in a **Chat**, select **Sleep** and then send a message to wake
  it, to get placeholders.

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
key only to retry the identical request. Output is kept to 64 KiB per stream by default (`SECRET_EXEC_OUTPUT_BYTES`), from the beginning.

Each job is a new non-interactive process: terminal exports, aliases, functions, activated
environments, and the terminal's current directory don't carry over, so source any setup the command
needs. Environment overrides are for non-secret values. `ENV`, `BASH_ENV`, `UID`, `EUID`, `PPID`,
`SHELLOPTS`, `BASHOPTS`, `BASH_VERSINFO` and `SAM_OIDC_TOKEN` can't be selected or overridden, and a managed variable
with one of these names makes every call fail. The container needs Bash and `setsid`; without them
the job fails rather than SAM replacing the container.

Cancelling stops the command's process group, but anything it started outside that group, such as
containers from `docker compose up -d`, keeps running. Stopping the session or workspace cancels its
jobs. If the VM agent stops, unfinished jobs end (`cancelled` after a clean shutdown, `interrupted`
after a crash) and are never re-run automatically.

Starting or restarting an agent fetches its environment from SAM each time. If that request fails,
the start fails and can be retried, rather than falling back to cached values that might hold real
secrets.

### Requesting and listing secrets

`request_secret` takes a `name` (`[A-Za-z_][A-Za-z0-9_]*`), a `reason` shown on the card, and an
optional `ttlSeconds` for the stored value. It returns at once with the request's ID, status and
deadline; it never returns or accepts a value. End the turn or keep working: when the request is
supplied, declined, or expires, the agent's chat gets a notice naming the request and the variable,
and the agent then runs `exec_with_secrets` with that name. The call fails for a reserved name, a name
the session's profile or skill already sets, or when the chat already has the maximum number of open
requests. It needs a task-backed session.

`list_runtime_env` (also `workspace_read` with `method: "runtime_env"`) lists the variable names this
session can use, without values: for each, whether it is a Secret, where it is set (`project`,
`profile` or `skill`), which lower scopes it overrides, when it expires, and, for values supplied
through a request, who supplied them and why. Expired values are left out.

## Use a short-lived identity instead of a stored key

Some services can trust SAM itself instead of a key you store, for example a cloud provider or a
vault that accepts OpenID Connect tokens. Ask the agent to run the command with
`exec_with_secrets` and an `oidc` audience; the command gets a short-lived `SAM_OIDC_TOKEN` that
says which project, profile and chat it comes from, and you don't store a secret at all. Setting up
the trust on the other side is up to you: see [Workload identity](/docs/guides/workload-identity/).
