---
title: Authenticate agents with workload identity
description: Give commands temporary access to external services using SAM-issued OIDC tokens instead of stored API keys.
---

Use workload identity when an external service can trust a signed JWT from SAM. Your agent requests a token for that service through `exec_with_secrets`; SAM injects it into the command as `SAM_OIDC_TOKEN`. You do not need a GCP connection, a Google OAuth client, or a stored secret.

You configure the trust relationship **in the receiving service**. SAM proves the identity of the executing workload; the receiving service decides what that identity may do. This is machine-to-machine federation, not an interactive browser sign-in provider.

## 1. Find your identity

Open a running chat, choose **Details**, then expand **Workload identity (OIDC)**. Copy the issuer, subject, and relevant IDs. The panel also shows readable names and automation origin when available. Viewing it does not mint a token. The chat has to be awake: on a sleeping chat the panel says "Identity details are unavailable. Reopen this section to retry. If this chat is asleep, wake it first."

For an installation at `example.com`:

- Issuer: `https://api.example.com/oidc`
- Discovery: `https://api.example.com/oidc/.well-known/openid-configuration`
- Public keys: `https://api.example.com/oidc/.well-known/jwks.json`

The subject has this format (each ID is independently URL-encoded):

```text
project:PROJECT_ID:user:USER_ID:profile:PROFILE_ID
```

A session without a profile uses `profile:none`. The subject is stable across executions using the same project, user and profile. Changing the profile changes the subject. Runtime/session IDs are separate claims so you can choose whether access survives a new chat or a wake into another runtime.

## 2. Set up trust in the service

In the service the command will call, trust SAM's issuer for an exact audience you choose (it need not be a URL) and an exact subject, or carefully constrained ID claims. Do not trust every token from the issuer without checking the workload identity. The issuer must be reachable from that service. Step-by-step examples for [Vault](#example-vault), [AWS, Google Cloud and your own service](#other-services) are below.

## 3. Ask the agent to use it

Tell the agent which command needs a token and for which audience, for example:

> Run `python3 scripts/call-service.py` with `exec_with_secrets` and an OIDC token for audience `vault`.

The command finds the token in `SAM_OIDC_TOKEN` and sends it to the service or its token-exchange endpoint. The token is created just before the command runs and normally expires after five minutes, so the command must use or exchange it straight away. Long-running commands get no refresh; a later run gets a fresh token. Existing **Secret** variables can be used alongside it.

The call the agent makes looks like this:

```json
{
  "command": "python3 scripts/call-service.py",
  "shell": "bash",
  "cwd": "/workspaces/my-repository",
  "secretNames": [],
  "oidc": { "audience": "vault" },
  "idempotencyKey": "call-service-1"
}
```

It polls `exec_with_secrets_status` with the returned job ID until the command finishes. Reuse an idempotency key only to retry the _same_ request; changing the audience changes the request.

`SAM_OIDC_TOKEN` is reserved. Do not add it to `env`, `secretNames`, project/profile/skill environment configuration, or shell startup files.

### If it fails

- **"OIDC audience must be a nonempty external audience without whitespace"**: the audience is empty, has spaces, or is one of SAM's own internal audiences. Use the exact audience the service is set up to accept.
- **The service rejects the token**: compare its issuer, audience and subject rules with the panel in step 1, and check the token hadn't expired before the command used it.
- **"Secret execution unavailable…"**: see [Run commands with secrets](/docs/guides/secret-execution/#troubleshooting).

## Claims you can use

All IDs come from SAM's authenticated session and stored records, not from command arguments or prompts. Optional claims are absent when the corresponding context is unavailable.

| Claim                                      | Meaning                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `iss`, `aud`, `sub`                        | Issuer, requested external audience, and stable project/user/profile subject                                               |
| `iat`, `exp`, `jti`                        | Issue time, expiry (Unix seconds), and unique token ID                                                                     |
| `type`                                     | Always `workload-identity`                                                                                                 |
| `project_id`, `project_name`               | Project running the workload                                                                                               |
| `user_id`, `user_name`                     | The chat's owner, even when a teammate it is [shared with](/docs/guides/collaboration/#share-a-chat) asked for the command |
| `agent_profile_id`, `agent_profile_name`   | Profile attached to the current agent runtime, not a project default or original task hint                                 |
| `chat_session_id`, `session_name`          | Persistent chat ID and current topic                                                                                       |
| `agent_session_id`                         | Agent runtime ID; distinct from the chat ID and may change after recovery                                                  |
| `workspace_id`                             | Current execution workspace; may change after recovery                                                                     |
| `agent_type`                               | Runtime agent type, when recorded                                                                                          |
| `skill_id`                                 | Attached skill, when present                                                                                               |
| `task_id`, `task_name`                     | Task associated with this execution                                                                                        |
| `parent_task_id`                           | Direct parent task, when recorded; does not confer the parent's permissions                                                |
| `triggered_by`                             | Recorded task creation source, such as `user`, `cron`, `webhook` or `mcp`                                                  |
| `trigger_id`, `trigger_execution_id`       | Trigger and run that created this task, when recorded                                                                      |
| `trigger_name`                             | Current trigger label, omitted if the trigger was deleted                                                                  |
| `automation_type`                          | Canonical origin: `trigger`, `schedule`, `standing_watch` or `workflow`                                                    |
| `automation_id`, `automation_execution_id` | Origin and execution IDs from the task's accepted submission                                                               |
| `automation_name`                          | Descriptive origin label captured when the task was submitted                                                              |

**Use IDs for authorization.** Names/topics are mutable, non-unique, user-controlled descriptions, limited to 160 characters. They are useful in logs, not access rules. Tokens are signed, not encrypted: the receiving service can read these labels. SAM does not include email addresses, prompts, webhook payloads, credential values or repository contents.

Automation claims describe **how this task was created**, not what caused the current turn. A human can subsequently message an automation-created chat. Child tasks and recovery tasks do not automatically inherit their ancestor's automation claims. Legacy tasks without an accepted submission can have trigger IDs but lack generic `automation_*` fields. Never interpret a missing claim as proof of a manual, trusted or unprivileged invocation.

## Example: Vault

A Vault administrator can enable JWT authentication and configure trust:

```bash
vault auth enable jwt
vault write auth/jwt/config \
  oidc_discovery_url="https://api.example.com/oidc" \
  bound_issuer="https://api.example.com/oidc"

vault write auth/jwt/role/sam-agent \
  role_type="jwt" \
  user_claim="sub" \
  bound_audiences="vault" \
  bound_subject="project:PROJECT_ID:user:USER_ID:profile:PROFILE_ID" \
  policies="agent-readonly" \
  ttl="5m"
```

Create the narrowly scoped `agent-readonly` policy first. Inside `exec_with_secrets`, request audience `vault` and POST the token to Vault's `/v1/auth/jwt/login` with role `sam-agent`. Consume the returned Vault token in the script without printing it. Vault also supports `bound_claims` if you want to require a particular trigger or other claim. See [Vault JWT authentication](https://developer.hashicorp.com/vault/docs/auth/jwt).

## Other services

- **AWS:** register the SAM issuer as an IAM OIDC provider, allow the intended audience (commonly `sts.amazonaws.com`), and constrain the role's trust policy by audience and subject. Exchange using `AssumeRoleWithWebIdentity`. Do not assume AWS supports arbitrary custom SAM claims in IAM conditions; the subject includes the profile ID for this reason. See [AWS OIDC federation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html).
- **Google Cloud:** configure a Workload Identity Federation provider trusting this issuer, map the subject and required ID claims, and set an attribute condition. Request the configured audience, then use Google's STS exchange. This generic issuer is separate from SAM's existing GCP provisioning integration; existing GCP trust settings remain unchanged. See [Google Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation-with-other-providers).
- **Your own service:** fetch discovery/JWKS and validate the RS256 signature, exact issuer, exact audience, expiration and subject/required claims with a JWT library. Decoding a token is not verification. Reject absent required claims.

Provider-specific exchange credentials can outlive the SAM token. Configure their lifetime and permissions independently. Stopping a chat does not immediately revoke a previously issued JWT or exchanged credential.

## Operator configuration and limitations

**Admin Settings → Operations → `operations.workloadIdentityTokenTtlSeconds`** sets the installation lifetime (default `300`, permitted range `1`–`600`). Changes apply to newly issued tokens after the settings cache refreshes (at most 60 seconds); existing tokens retain their expiry. Invalid stored configuration or an unavailable settings database fails issuance closed. No additional signing secret or database migration is required: SAM uses its installation-managed RSA key with a separate external issuer. The key ID is derived from the public key, so redeploys and calendar changes do not change it.

The current JWKS publishes the active installation key only. Replacing the installation key invalidates old signatures once verifiers refresh their keys; cached keys and issued credentials may remain valid until their own expiry. Coordinate key rotation with consumers and their JWKS caching behavior. This feature does not provide an overlapping-key rotation manager or instant revocation.

The token is injected only into the selected command environment, never returned in the MCP result. Exact token bytes printed to captured output are redacted before persistence. As with other `exec_with_secrets` values, transformed output, files, subprocesses and network transmissions are **not** protected by that redaction. Credentials returned by an external exchange are not automatically added to SAM's exact-value redaction list. Keep them inside the script and never print them.
