---
title: MCP Servers
description: Give SAM agents access to third-party services — Zapier, executor.sh, Composio, Notion, Linear and more — by connecting any MCP endpoint.
---

SAM agents can use tools from any [Model Context Protocol](https://modelcontextprotocol.io/) server you connect. You do the OAuth in your provider's own dashboard, paste the endpoint into SAM, and every agent session gets those tools alongside SAM's own.

SAM does not build per-service connectors. It speaks MCP, and the endpoint owns the authentication — so you are never limited to services SAM happens to support, and self-hosters can point at a gateway they run themselves.

## How it works

1. Pick a provider (see below) and connect the services you want **in that provider's dashboard**. That is where the OAuth happens, in your browser.
2. The provider gives you an MCP endpoint URL, usually with a bearer token.
3. Paste both into SAM under **Settings → MCP Servers** (yours alone) or **Project Settings → Runtime** (shared with the project).
4. Start a chat or task. The agent sees the new tools immediately, namespaced by the name you chose.

This works on both runtimes — VM workspaces and Instant (container) sessions.

How the endpoint reaches the agent depends on the agent. Claude Code receives it in the session handshake, Codex and Vibe get it written into their own config files, and Amp reaches it through a bridge. Agents that do not implement remote MCP servers will not see the tools.

## Choosing a provider

| Provider | Best for | Auth |
| --- | --- | --- |
| [Zapier MCP](https://zapier.com/mcp) | Breadth — around 9,000 apps, including LinkedIn and Google Docs | Bearer token |
| [executor.sh](https://executor.sh/) | Open source (MIT). Run it yourself via CLI, Docker or a Cloudflare Worker, or use their hosted endpoint | Bearer token |
| [Composio / Rube](https://composio.dev/) | Managed OAuth with a large toolkit catalog | Pre-signed URL — choose **None** |
| [Klavis / Strata](https://www.klavis.ai/) | Self-hosting everything (Apache-2.0) | Bearer token |
| Official service endpoints | A single service you already pay for — GitHub, Notion, Linear, Sentry, Stripe | Personal access token as bearer |

Prefer gateway-style providers that expose a small number of tools over servers that dump a hundred tool definitions into the agent's context. Every tool definition costs context window on every turn.

## Adding a server

| Field | Notes |
| --- | --- |
| **Name** | How the agent sees the server; its tools are namespaced by it. 1–32 characters, lowercase letters, digits and hyphens; it may not start or end with a hyphen. `sam-mcp` is reserved. |
| **MCP endpoint URL** | Must be HTTPS. `http://localhost:<port>` and `http://127.0.0.1:<port>` are allowed for a gateway running on the same machine — an explicit port is required. |
| **Authentication** | **Bearer token** for most providers. **None** when the credential is embedded in the URL itself, as with Composio's pre-signed URLs. |

Both the URL and the token are encrypted at rest and are never returned by the API or shown again after you save them — several providers put the credential directly in the URL, so the URL is treated as a secret too. SAM shows only the host.

## Scopes

| Scope | Where | Who it applies to |
| --- | --- | --- |
| **Personal** | Settings → MCP Servers | Every session *you* start, in any project |
| **Project** | Project Settings → Runtime | Every session any member starts in that project |

If a project server and a personal server share a name, the project one wins. Adding or changing a project-scoped server requires the `secret:write` capability, so project owners and admins can manage them but maintainers and viewers cannot.

Use the **Disable** toggle to stop injecting a server without deleting it and losing the credential.

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

- **LinkedIn** — the official API only supports *posting*; it cannot read your feed, DMs or arbitrary profiles. Any MCP server that reads the feed drives a member session cookie, which violates LinkedIn's user agreement. Posting works through Zapier and Composio; reading is a risk decision that belongs to you and your chosen vendor.
- **Medium** — the API is closed to new integrations and no new tokens are issued. Publish to Dev.to, Hashnode, Ghost or WordPress instead, or to a company blog through the GitHub repository SAM already connects to.

## Limitations

- **Remote HTTP servers only.** `stdio` servers are not supported: configuring an arbitrary command from a web UI is an unnecessary attack surface, and every major provider is remote-first.
- **Bearer or no authentication.** Custom auth headers (for example `X-API-Key`) are not yet supported.
- **Personal and project scope only.** Attaching a server to a specific agent profile or skill is not yet supported.
- **Amp exposes the endpoint URL locally.** The Amp harness reaches remote MCP servers through a bridge process that receives the URL as a command-line argument, so anything running inside that same workspace can read it. The bearer token is not exposed this way. If your endpoint's URL is itself the credential (a pre-signed URL), prefer a different agent for now.
