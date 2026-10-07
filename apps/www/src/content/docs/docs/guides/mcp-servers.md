---
title: MCP Servers
description: Give SAM agents access to third-party services — Zapier, executor.sh, Composio, Notion, Linear and more — by connecting any MCP endpoint.
---

SAM agents can use tools from any [Model Context Protocol](https://modelcontextprotocol.io/) server you connect. You do the OAuth in your provider's own dashboard, paste the endpoint into SAM, and every agent session gets those tools alongside SAM's own.

SAM does not build per-service connectors. It speaks MCP, and the endpoint owns the authentication — so you are never limited to services SAM happens to support, and self-hosters can point at a gateway they run themselves.

## How it works

1. Pick a provider (see below) and connect the services you want **in that provider's dashboard**. That is where the OAuth happens, in your browser.
2. The provider gives you an MCP endpoint URL, usually with a bearer token or an API key to send in a header.
3. Paste them into SAM under **Settings → MCP Servers** (yours alone) or **Project Settings → Runtime** (shared with the project).
4. Start a chat or task. The agent sees the new tools immediately, namespaced by the name you chose.

This works on both runtimes — VM workspaces and Instant (container) sessions.

How the endpoint reaches the agent depends on the agent. Claude Code receives it in the session handshake, Codex and Vibe get it written into their own config files (Codex reads the token and header values from environment variables, so they never land in its config file), and Amp reaches it through a bridge. Agents that do not implement remote MCP servers will not see the tools.

## Choosing a provider

| Provider                                  | Best for                                                                                                | Auth                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Zapier MCP](https://zapier.com/mcp)      | Breadth — around 9,000 apps, including LinkedIn and Google Docs                                         | Bearer token                                                                                                                                      |
| [executor.sh](https://executor.sh/)       | Open source (MIT). Run it yourself via CLI, Docker or a Cloudflare Worker, or use their hosted endpoint | Bearer token                                                                                                                                      |
| [Composio / Rube](https://composio.dev/)  | Managed OAuth with a large toolkit catalog                                                              | API key header — choose **None** and add an `x-api-key` header (`x-consumer-api-key` for Composio Connect). Older pre-signed URLs need no header. |
| [Klavis / Strata](https://www.klavis.ai/) | Self-hosting everything (Apache-2.0)                                                                    | Bearer token                                                                                                                                      |
| Official service endpoints                | A single service you already pay for — GitHub, Notion, Linear, Sentry, Stripe                           | Personal access token as bearer                                                                                                                   |

Prefer gateway-style providers that expose a small number of tools over servers that dump a hundred tool definitions into the agent's context. Every tool definition costs context window on every turn.

## Adding a server

| Field                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**             | How the agent sees the server; its tools are namespaced by it. 1–32 characters, lowercase letters, digits and hyphens; it may not start or end with a hyphen. `sam-mcp` is reserved.                                                                                                                                                                                                                                                                                                                                                                                    |
| **MCP endpoint URL** | Must be HTTPS. `http://localhost:<port>` and `http://127.0.0.1:<port>` are allowed for a gateway running on the same machine — an explicit port is required.                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Authentication**   | **Bearer token** for most providers. **None** when the credential travels in the URL itself (pre-signed URLs) or in a custom header.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Headers**          | Optional HTTP headers sent with every request, for providers that take an API key in a header — Composio's `x-api-key`, for example. Names are 1–64 letters, digits, hyphens or underscores. Headers the MCP transport sets itself (`Accept`, `Content-Type`, `Host`, `Connection`, `Content-Length`, `Transfer-Encoding`, `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Last-Event-ID`) cannot be overridden. `Authorization` is accepted only when Authentication is **None**, so you can use a scheme other than Bearer. By default a server can have up to 10 headers. |

The URL, the token and every header value are encrypted at rest and are never returned by the API or shown again after you save them — several providers put the credential directly in the URL, so the URL is treated as a secret too. SAM shows only the host and the header names.

## Editing a server

Use **Edit** to rename a server, switch its authentication, or add, replace and remove headers. Saved secrets are never shown, so the URL, the token and each saved header value start blank: leave them blank to keep what is saved, or type a new value to replace it. To rename a header, remove it and add it again under the new name.

## Scopes

| Scope        | Where                      | Who it applies to                               |
| ------------ | -------------------------- | ----------------------------------------------- |
| **Personal** | Settings → MCP Servers     | Every session _you_ start, in any project       |
| **Project**  | Project Settings → Runtime | Every session any member starts in that project |

If a project server and a personal server share a name, the project one wins. Adding or changing a project-scoped server requires the `secret:write` capability, so project owners and admins can manage them but maintainers and viewers cannot.

Use the **Disable** toggle to stop injecting a server without deleting it and losing the credential.

## When a server needs sign-in

How a chat shows that an MCP server isn't signed in depends on the server:

- **The server's tools are missing from the session, or a tool step fails with the server's own
  error**, such as `401 Unauthorized`. The server refused the credential SAM sent. Review its entry
  under **Settings → MCP Servers**, or ask a project administrator to check **Project Settings →
  Runtime** for a shared server. A bearer token works only if that service accepts bearer
  authentication; some services need an API-key header instead (see
  [Adding a server](#adding-a-server)).
- **The server sends you a link.** Some servers ask you to approve access on their own website. The
  chat shows an **External service request** card with the destination; open the link, finish
  there, then select **Continue after opening**. See
  [Links to open](/docs/guides/chat-features/#links-to-open).
- **The chat says "This sign-in flow requires a local callback that this session cannot complete".**
  The service wants to finish its sign-in by redirecting to `localhost`, which can't work from a
  remote SAM session. Use another authentication method the service supports for remote clients,
  usually a token or API key from its dashboard.

The last two only happen in sessions labelled **Chat** (see
[Chat or Task](/docs/guides/chat-features/#chat-or-task)), only where link requests are turned on
(they are on the hosted service; self-hosted operators turn them on as described in
[Let agents ask in chat](/docs/guides/self-hosting/#let-agents-ask-in-chat)), and usually not in a
chat that has slept and woken. Elsewhere
a server that wants a browser sign-in just fails, or its tools don't appear, so connect it with a
token or API key from its dashboard instead. The chat's shortcut to personal MCP settings appears
only for the person who started it; shared servers are managed by project administrators.

## Security

Tools from a connected MCP server run inside your agent's session, which already has full repository and shell access. Their descriptions and their output both enter the agent's context, which makes a third-party MCP server a prompt-injection surface.

- Connections are always explicit opt-in. SAM never seeds one.
- Only connect endpoints you trust, and prefer providers that scope their access to the specific services you authorized.
- Project-scoped servers are shared: every member's agents will use that credential.
- SAM validates the URL's scheme but does not resolve or pin its address. A hostname you
  control can be pointed at a private address after the fact, so a project-scoped endpoint is
  effectively a request originating from inside another member's workspace network. Only add
  project-scoped endpoints from providers you trust.

## Notes on specific services

- **LinkedIn** — the official API only supports _posting_; it cannot read your feed, DMs or arbitrary profiles. Any MCP server that reads the feed drives a member session cookie, which violates LinkedIn's user agreement. Posting works through Zapier and Composio; reading is a risk decision that belongs to you and your chosen vendor.
- **Medium** — the API is closed to new integrations and no new tokens are issued. Publish to Dev.to, Hashnode, Ghost or WordPress instead, or to a company blog through the GitHub repository SAM already connects to.

## Limitations

- **Remote HTTP servers only.** `stdio` servers are not supported: configuring an arbitrary command from a web UI is an unnecessary attack surface, and every major provider is remote-first.
- **Personal and project scope only.** Attaching a server to a specific agent profile or skill is not yet supported.
- **Amp exposes the endpoint URL locally.** The Amp harness reaches remote MCP servers through a bridge process that receives the URL and the header names as command-line arguments, so anything running inside that same workspace can read them. The bearer token and header values are not exposed this way. If your endpoint's URL is itself the credential (a pre-signed URL), prefer a different agent for now.

## GitHub automation triggers

Agents can create GitHub event triggers for their current SAM project with `create_trigger`:

```json
{
  "name": "Triage new bugs",
  "sourceType": "github",
  "githubConfig": {
    "eventType": "issues",
    "filters": { "actions": ["opened"], "labels": ["bug"], "ignoreActors": ["dependabot[bot]"] }
  },
  "promptTemplate": "Triage {{github.title}}: {{github.body}}"
}
```

Choose `issues`, `issue_comment`, `pull_request`, or `push`. Filters support `actions`, `labels`, `ignoreActors`, `commandPrefix`, `bodyContains`, `branches`, and `ignoreDrafts`. Your installation must have GitHub event triggers enabled and receive the relevant GitHub App events for the project repository.

Use `agentProfileId` to select a profile in the current project, or omit it to use the project default. Use `update_trigger` with the trigger ID and `githubConfig` to replace the event type and filters. Include the event type on every configuration update; `filters: {}` clears all filters. The trigger's source type cannot be changed.

Cron callers can continue to omit `sourceType` and supply `cronExpression`. GitHub triggers do not take cron schedule fields. Webhook creation accepts `sourceType: "webhook"`, an explicit project-local `agentProfileId`, and `webhookConfig`. It returns an expiring authenticated one-time URL, never the secret. Redeem from the originating workspace/session with `SAM_MCP_TOKEN` and pipe the response into secret storage. See [Webhook Triggers](/docs/guides/webhook-triggers/#creating-webhooks-through-mcp). Filter management, preview, and rotation remain available through the UI or authenticated REST API.
