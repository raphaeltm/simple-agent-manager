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

For shell syntax, use `command` with an explicit `shell` of `bash` or `sh` instead of `argv`. Literal `argv` does not expand `$VARIABLE`, pipes, or redirects. This starts a new noninteractive process with no terminal or shell startup files. Terminal exports, aliases, functions, activation, and the terminal’s current directory do not carry over. Supply an absolute `cwd` or use the session worktree default, and explicitly source any setup your command needs. Environment overrides are for nonsecret values. `ENV` and `BASH_ENV` are reserved startup controls and cannot be selected or overridden. `UID`, `EUID`, `PPID`, `SHELLOPTS`, `BASHOPTS`, and `BASH_VERSINFO` are unsupported readonly Bash names and are rejected before execution, including in managed environment rows.

Output is bounded, and exact selected secret values are replaced with `[REDACTED]` before results are saved or returned. Encoded, transformed, or file-written values are outside that protection. Commands can still read their selected values and use the workspace’s network. This reduces accidental disclosure; it does not isolate secrets from agent-controlled code. The current container needs Bash and `setsid`; SAM fails the job if those are unavailable rather than replacing the container.

The tool requires an updated VM agent. Deployment publishes the new agent artifacts, but already running nodes may still use an older version without this endpoint. On those nodes, secret execution is unavailable; the request does not wake, recreate, or restart the container or agent session. Verify rollout on a fresh node before relying on the tool.

Starting or restarting an agent also requires the control plane's runtime-assets endpoint, including in an existing container. If that request fails or times out, startup fails and must be retried after service recovers. SAM does not fall back to cached environment values: they may contain legacy secrets or omit the current profile's protected names. This dependency affects new process startup; it does not stop an already running agent.

Existing active sessions keep their original environment. Results identify `execution.environmentMode` as `legacy` when existing managed env files still differ from the placeholder environment. No automatic session restart or container replacement occurs. Agent provider authentication, SAM/MCP/Git credentials, and secret runtime **files** retain their existing delivery paths. Fresh session processes also apply their current profile/skill env overlay in existing containers without rewriting shared runtime files. If a protected managed name conflicts with an essential harness env credential, startup fails with a clear error. Use a distinct managed name or an existing auth-file credential; SAM does not silently replace the placeholder with the harness value.

Cancellation stops the supervised command’s process group. Detached external effects, such as containers launched with `docker compose -d`, can persist. Accepted jobs retain a bounded activity lease even when the agent turn ends. Explicit session/workspace stop cancels their supervised processes. Results retain selected names, actor/session/workspace IDs, command mode/fingerprint and timestamps for private audit, without storing literal commands or injected values. A VM-agent restart marks unfinished jobs `interrupted`; SAM does not replay commands automatically.

## Use temporary workload identity instead of a stored key

Pass `oidc: { "audience": "your-service" }` to receive a short-lived `SAM_OIDC_TOKEN` inside the command. You can use an empty `secretNames` list. See [workload identity](/docs/guides/workload-identity/) for trust setup, available project/profile/session/automation claims, and examples.
