---
title: Use SAM from Claude and ChatGPT
description: Connect your AI app to SAM to find projects, start work, answer agents, and follow progress.
---

The SAM Connector lets an AI app act as you in SAM. It can find projects and ideas, read progress, start a project chat, answer an agent, and stop work. Questions about repository files start or continue a visible project chat; the Connector does not read repository files directly.

## Connect an app

Open **Settings → Access** in SAM. Copy the Connector URL or choose **Add to Claude**. The URL uses your installation's API host and ends in `/connect/mcp`.

In Claude, add the custom connector and connect it. In ChatGPT, open the custom app or MCP server creation flow, enter the URL, select OAuth, and install the app. Some accounts require Developer mode. ChatGPT availability and mobile support depend on your account and plan.

SAM asks you to sign in and approve access. Check the app name, redirect host, and requested permissions. A local-program warning is expected for command-line clients using a loopback callback. Approve only a connection you initiated.

- **sam.read:** see projects, chats, tasks, ideas, and supporting context you can access.
- **sam.write:** start, steer, and stop work as you. Answering agent permission requests requires confirmation each time.
- **offline_access:** stay connected until you revoke access or the grant expires.

Try “What needs my attention?” or “Start a chat in my project to investigate the failing tests.” Results include links back to SAM. Starting work can provision compute and is subject to installation limits.

Chat results show the newest message groups first. Pagination counts stored streaming rows; follow `nextCursor` for older content. A group split across pages includes `partialBefore` or `mayContinueInNewerPage`, and shortened summaries include `truncated`. Task final-message summaries combine adjacent assistant fragments from a bounded recent window. During a long tool run, that window can contain no assistant text and the summary is `null`; read the chat for older progress.

Agent requests appear in your inbox and in chats you created, including the available permission options or form fields. Confirm each answer before sending it. Connector clients submit an `interactionId` with an `optionId`, `formContent`, or `decline: true`; SAM generates the answer receipt metadata. URL requests use `optionId: "accept"` after confirmation.

## Command-line clients

Replace the example URL with the URL from Settings → Access:

```sh
claude mcp add --transport http sam https://api.example.com/connect/mcp
codex mcp add sam --url https://api.example.com/connect/mcp
codex mcp login sam
```

For personal access token authentication, create an API token in the same Access page, store it securely in `SAM_CONNECTOR_TOKEN`, and use:

```sh
claude mcp add --transport http sam https://api.example.com/connect/mcp --header "Authorization: Bearer $SAM_CONNECTOR_TOKEN"
codex mcp add sam --url https://api.example.com/connect/mcp --bearer-token-env-var SAM_CONNECTOR_TOKEN
```

## Disconnect or manage access

In **Settings → Access → Connected apps**, choose **Revoke** and confirm. This revokes the app's OAuth grant. Token revocation propagation may take about a minute. Personal API tokens are managed separately in the existing API tokens section.

Administrators use **Admin → Integrations → Connector** to disable the Connector, allow read-only access, control registration hosts and token lifetimes, set rate and start limits, revoke connections, and block registered clients. Save writes only the settings you changed. **Reset to default** removes an individual runtime override and restores its environment fallback or built-in default. The Connector is enabled by default, including on self-hosted installations. Disabling it rejects existing tokens without deleting grants. When write access changes, refresh ChatGPT's tool list.

## Self-hosted installations

Your installation is its own OAuth issuer. The API host, discovery endpoints, `/oauth/*`, and `/connect/mcp` must be reachable by the client and vendor servers. Cloudflare Access login walls, WAF challenges, and network restrictions can prevent discovery or token exchange; configure an appropriate policy for these endpoints while keeping SAM's OAuth authentication in place. The web host must also be reachable for login and consent.

The workspace-injected `sam-mcp` server remains a separate agent interface. Do not use its task-bound URL or token as the user Connector.

Connections revoked in Settings or Admin are rejected immediately by SAM's D1 authorization gate; the OAuth provider also deletes their tokens from KV. Refresh tokens rotate on every successful refresh. Reusing a spent refresh token revokes the connection, including access tokens, and requires reconnecting the app. Tokens are stored hashed and their authorization properties encrypted.

Self-host operators can bound public dynamic registration with `CONNECTOR_REGISTRATION_PER_IP_PER_HOUR` (20) and `CONNECTOR_REGISTRATION_GLOBAL_PER_HOUR` (100). The installation-wide limit uses atomic D1 admission. OAuth bodies are limited to `CONNECTOR_OAUTH_REQUEST_MAX_BYTES` (16 KiB). Dynamic clients expire after `CONNECTOR_CLIENT_IDLE_TTL_SECONDS` (90 idle days), renewed on token exchange.

Deployment forwards explicitly configured `CONNECTOR_*` environment variables; Admin overrides take precedence and **Reset to default** removes the override. Registration names are bounded by `CONNECTOR_CLIENT_NAME_MAX_LENGTH` (200 characters) and redirect lists by `CONNECTOR_REDIRECT_URI_MAX_COUNT` (10). Registration IP limits apply to shared vendor/NAT egress, so operators should size the per-IP and atomic global caps for their expected connection volume. MCP requests are bounded by `CONNECTOR_REQUEST_MAX_BYTES` (256 KiB), complete responses including text and structured data by `CONNECTOR_RESPONSE_MAX_BYTES` (120,000 bytes), and inbox session fanout by `CONNECTOR_INBOX_SESSION_LIMIT` (5).
