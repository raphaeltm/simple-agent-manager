---
title: Run commands with secrets
description: Give a command selected secret environment variables without placing them in the agent’s ordinary environment.
---

Mark sensitive project, agent profile, or skill environment variables as **Secret** in their runtime settings. In fresh workspaces, agents see a recognizable placeholder such as `__SAM_SECRET_REQUIRES_EXEC_WITH_SECRETS__SERVICE_TOKEN__` instead of the value. Nonsecret variables keep their normal values and precedence: project, then profile, then skill.

Ask the agent to use `exec_with_secrets` for commands that need those variables:

```json
{
  "argv": ["python3", "deploy.py"],
  "secretNames": ["SERVICE_TOKEN"],
  "cwd": "/workspaces/my-project",
  "timeoutMs": 60000,
  "idempotencyKey": "deploy-attempt-1"
}
```

The command runs as the session’s user in its existing workspace with its live files and network access. Only the selected secret names receive values. Other managed secrets remain placeholders. The tool returns a job ID; the agent polls `exec_with_secrets_status` until the command finishes. Reuse an idempotency key only for retries of the identical request. `exec_with_secrets_cancel` requests cancellation; poll until the result becomes terminal.

For shell syntax, use `command` with an explicit `shell` of `bash` or `sh` instead of `argv`. Literal `argv` does not expand `$VARIABLE`, pipes, or redirects. This starts a new noninteractive process with no terminal or shell startup files. Terminal exports, aliases, functions, activation, and the terminal’s current directory do not carry over. Supply an absolute `cwd` or use the session worktree default, and explicitly source any setup your command needs. Environment overrides are for nonsecret values.

Output is bounded, and exact selected secret values are replaced with `[REDACTED]` before results are saved or returned. Encoded, transformed, or file-written values are outside that protection. Commands can still read their selected values and use the workspace’s network. This reduces accidental disclosure; it does not isolate secrets from agent-controlled code. The current container needs Bash and `setsid`; SAM fails the job if those are unavailable rather than replacing the container.

Existing active sessions keep their original environment. Results identify `execution.environmentMode` as `legacy` when existing managed env files still differ from the placeholder environment. No automatic session restart or container replacement occurs. Agent provider authentication, SAM/MCP/Git credentials, and secret runtime **files** retain their existing delivery paths. A managed env name colliding with a harness credential does not remove the harness’s separate authentication requirement.

Cancellation stops the supervised command’s process group. Detached external effects, such as containers launched with `docker compose -d`, can persist. A VM-agent restart marks unfinished jobs `interrupted`; SAM does not replay commands automatically.
