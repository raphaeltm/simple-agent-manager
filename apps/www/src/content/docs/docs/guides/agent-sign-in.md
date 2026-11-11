---
title: Let agents sign in to a test instance
description: Allow an agent running on one SAM installation to sign in as a chosen test user on another installation, using SAM's workload identity token.
---

An agent that tests a SAM installation often needs a real browser session there. If the
installation is a **test instance** (a staging or throwaway self-hosted install), you can let an
agent running on another SAM installation that you trust sign in directly. The agent gets a
[workload identity token](/docs/guides/workload-identity/) from its own installation and
exchanges it for an ordinary, short-lived session as a user you picked in advance.

Nothing changes on an installation that is not configured for this. The feature is off unless
the operator sets one deploy-time secret, and while it is off the sign-in endpoint does not
exist.

:::caution[Test instances only]
Turn this on only for installations that hold test data. Whoever controls the trusted
installation, and anyone who can run commands in the allowed project as the allowed user, can
sign in as the target users you list.
:::

## How it works

1. The agent runs a command with `exec_with_secrets` and `oidc: { audience }`. Its own SAM
   installation (the **trusted issuer**) gives the command a signed token naming the project,
   user, profile and task it runs for.
2. The command posts that token, plus the account to sign in as (the **target**), to the test
   instance's `POST /api/auth/workload-identity-login`.
3. The test instance checks the token's signature against the issuer's published keys, the
   exact issuer, the exact audience, the expiry and the `type` claim, then checks that the source
   project and user, and the target, are on its allowlists. It creates a normal session for the
   target and records the sign-in.

Each token can be used once. The session expires after one hour by default and is not extended
while in use. The endpoint never creates accounts and never changes anyone's role; the target
must already exist and pass the same approval checks as any other sign-in.

An agent session can use the app like the target user, but it cannot turn itself into a longer
lived credential: it cannot create personal access tokens, approve a CLI device sign-in, grant
connector (OAuth) consent, or link a social account. It can sign out. Anything else the target
account can create, such as triggers, workspaces or stored credentials, it can create too, so
choose target accounts that only hold test data.

## Set it up (operator, once)

You need three things from the **trusted** installation. Open a running chat there, choose
**Details**, and expand **Workload identity (OIDC)** (see
[Find your identity](/docs/guides/workload-identity/#1-find-your-identity)):

- **Issuer**, for example `https://api.example.com/oidc`
- **Project ID** of the project the agent will run in
- **User ID** of the user who owns the agent's chats in that project

On the **test** instance, decide which existing accounts agents may sign in as. Use account IDs
where you can. Email addresses also work and are matched case-insensitively against the stored
account, but an address can be registered again if its account is deleted, while an ID cannot.

Then set one value, `AGENT_SIGN_IN_TRUST`, on the test instance:

```json
{
  "issuer": "https://api.example.com/oidc",
  "allowedSources": [{ "projectId": "TRUSTED_PROJECT_ID", "userId": "TRUSTED_USER_ID" }],
  "allowedTargets": ["TEST_USER_ID", "smoke-test@example.org"]
}
```

| Field                     | Required | Meaning                                                                                                                                                                               |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuer`                  | yes      | The trusted installation's issuer, exactly as shown in its identity panel. `https` only, no trailing slash.                                                                           |
| `allowedSources`          | yes      | Project and user pairs from the token's `project_id` and `user_id` claims. Both must match the same entry. An entry may also name `agentProfileId` to accept only that agent profile. |
| `allowedTargets`          | yes      | Account IDs or email addresses on this instance, or the string `"*"` for any account (see below).                                                                                     |
| `sessionTtlSeconds`       | no       | Session lifetime, `60`–`86400`. Default `3600`.                                                                                                                                       |
| `maxSignInsPerHour`       | no       | Accepted sign-ins per source project and user in any rolling hour, `1`–`1000`. Default `20`.                                                                                          |
| `maxAttemptsPerIpPerHour` | no       | Exchange attempts per client IP per hour, checked before the token is verified, `1`–`10000`. Default `60`.                                                                            |
| `jwksCacheSeconds`        | no       | How long the issuer's public keys are cached, `30`–`3600`. Default `600`.                                                                                                             |
| `jwksTimeoutSeconds`      | no       | Timeout for fetching the issuer's public keys, `1`–`30`. Default `5`.                                                                                                                 |
| `clockToleranceSeconds`   | no       | Allowed clock difference between the installations, `0`–`300`. Default `30`.                                                                                                          |

Unknown fields, a missing field or an invalid value switch the feature off and log
`agent_sign_in.config_invalid`. A typo can never widen what is allowed.

`"allowedTargets": "*"` lets the trusted workloads sign in as **any** account on the test
instance, including administrators and accounts connected to real GitHub organizations or
cloud credentials. Use an explicit list unless every account on the instance is disposable. A
`"*"` inside a list is rejected.

Where to set the value:

- **SAM's GitHub Actions deployment:** add `AGENT_SIGN_IN_TRUST` as a secret of the GitHub
  Environment you deploy (for example `staging`), then run the deployment. The deploy copies it
  to the API Worker. Write the JSON on one line: GitHub masks multi-line secrets line by line.
  The GitHub secret is the only source: a value set by hand on the Worker is removed by the next
  deployment. It cannot be set from the admin settings page or the API.
- **Local development:** add it to `apps/api/.dev.vars`.

The test instance must have an administrator account before agents can sign in.

To turn the feature off, delete the secret and deploy again. The deployment removes the Worker
secret when the GitHub secret is gone.

### The audience

The audience the agent requests is the test instance's own endpoint URL:

```text
https://api.TEST_INSTANCE_DOMAIN/api/auth/workload-identity-login
```

A token minted for any other audience is rejected, so a token an agent requested for some other
service cannot be used here.

## Sign in as an agent

Three steps, from inside a chat on the trusted installation. Replace `test.example.org` with the
test instance's domain and `smoke-test@example.org` with an allowed target.

**1. Exchange a token for a session.** Call `exec_with_secrets`:

```json
{
  "shell": "bash",
  "secretNames": [],
  "oidc": { "audience": "https://api.test.example.org/api/auth/workload-identity-login" },
  "command": "printf '{\"token\":\"%s\",\"target\":\"%s\"}' \"$SAM_OIDC_TOKEN\" 'smoke-test@example.org' | curl -sS --fail-with-body https://api.test.example.org/api/auth/workload-identity-login -H 'content-type: application/json' --data-binary @-"
}
```

The response names the account you are signed in as and carries `sessionCookie`, a value of the
form `__Secure-better-auth.session_token=VALUE`.

**2. Give the session to the browser.** In Playwright (for example the Playwright MCP
`browser_run_code` tool), add the cookie for the test instance's domain and open the app:

```js
await page.context().addCookies([
  {
    name: '__Secure-better-auth.session_token',
    value: 'VALUE', // everything after the first "=" in sessionCookie
    domain: '.test.example.org',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  },
]);
await page.goto('https://app.test.example.org');
```

**3. Work, then sign out** from the user menu when you are done. Signing out deletes the
session at once instead of leaving it valid until it expires.

The session value appears in the command output and therefore in the chat, where anyone who can
read the chat could use it until it expires or you sign out. It cannot be extended or turned into
another credential. If your Playwright runs as a script rather than through the MCP tool, write
the response to a file readable only by you (`umask 077; curl … -o session.json`) and read it
in the script instead of printing it.

## Audit

Every accepted sign-in writes a row to the test instance's `agent_sign_ins` table: issuer, token
ID, the source subject, project, user, profile, task and workspace, the target account, the
session and its expiry. The row is kept after sign-out. Rejections are logged as
`agent_sign_in.rejected` with a reason.

Anyone using the test instance can tell it accepts agent sign-in: its sign-in page says so.

## If it fails

| Response                                           | Meaning                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `404 NOT_FOUND`                                    | The feature is off on this instance, or its configuration is invalid.                                               |
| `401 … (audience)`                                 | The token was requested for a different audience. Use the URL from [The audience](#the-audience).                   |
| `401 … (issuer)`, `(unknown_key)`, `(signature)`   | The token did not come from the configured issuer, or that issuer's keys changed.                                   |
| `401 … (expired)`, `(too_old)`, `(not_yet_valid)`  | Use the token straight away; check both installations' clocks.                                                      |
| `401 … (replayed)`                                 | Each token works once. Run the command again for a fresh token.                                                     |
| `401 … (claims)`, `(algorithm)`, `(malformed)`     | Not a SAM workload identity token.                                                                                  |
| `403 This workload is not allowed to sign in here` | The token's project and user are not an `allowedSources` pair.                                                      |
| `403 Target user is not allowed for agent sign-in` | The target does not exist or is not in `allowedTargets`.                                                            |
| `403` pending approval or suspended                | The target account cannot sign in at all right now.                                                                 |
| `403 … until this instance has an administrator`   | The test instance has no administrator account yet. Sign one in first.                                              |
| `403 Agent sign-in sessions cannot create …`       | The agent session tried to create a token, approve a device or grant consent. Not allowed.                          |
| `429`                                              | Too many sign-ins for this source in the last hour, or too many attempts from this address; wait for `Retry-After`. |
| `503 ISSUER_KEYS_UNAVAILABLE`                      | The test instance could not fetch the issuer's public keys. Check that the issuer is reachable.                     |
