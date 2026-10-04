---
title: Security Model
description: How SAM handles authentication, encryption, and credential management.
---

SAM's security model separates **platform secrets** (managed by operators) from **user credentials** (encrypted per-user in the database).

## Cloud Credential Model (BYOC + Platform Fallback)

SAM supports **Bring-Your-Own-Cloud (BYOC)**: users and self-hosters may store their own Hetzner, Scaleway, Vultr, Infomaniak, DigitalOcean, UpCloud, or GCP credentials, encrypted per-user in D1. This is the model for self-hosted deployments and BYO-key users.

However, SAM's own hosted deployment also has an **enabled platform-level cloud credential** (`platform_credentials`, `provider=hetzner`, `credential_type=cloud-provider`). VM provider resolution uses **project credential → user credential → platform credential**, so on the hosted (zero-config) platform a user does **not** need their own cloud credential for SAM to provision workspaces or deployment nodes when the project or platform can supply one. Self-hosted deployments without a project or platform credential rely on user-supplied BYOC tokens.

## Credential Types

### Platform Secrets

These Cloudflare Worker secrets are generated or copied during deployment and are required for a fully functional install:

| Secret                       | Purpose                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY`             | AES-256-GCM master key for BetterAuth sessions and user credential encryption                                                                     |
| `BETTER_AUTH_SECRET`         | Optional override for BetterAuth session cookies (falls back to `ENCRYPTION_KEY`)                                                                 |
| `CREDENTIAL_ENCRYPTION_KEY`  | Optional override for user credential encryption (falls back to `ENCRYPTION_KEY`)                                                                 |
| `JWT_PRIVATE_KEY`            | RSA-2048 key for signing workspace and callback tokens                                                                                            |
| `JWT_PUBLIC_KEY`             | RSA-2048 key for token verification (exposed via JWKS)                                                                                            |
| `DEPLOY_SIGNING_PRIVATE_KEY` | Ed25519 key for signing deployment apply payloads (auto-generated)                                                                                |
| `DEPLOY_SIGNING_PUBLIC_KEY`  | Ed25519 key for deployment-node payload verification (auto-generated)                                                                             |
| `TRIAL_CLAIM_TOKEN_SECRET`   | HMAC secret for trial onboarding claim tokens (auto-generated)                                                                                    |
| `CF_API_TOKEN`               | Cloudflare deploy, DNS, Origin CA certificate issuance, observability, and AI Gateway operations (requires Account → SSL and Certificates → Edit) |
| `CF_ACCOUNT_ID`              | Cloudflare account identifier used by account-scoped Cloudflare APIs                                                                              |
| `CF_ZONE_ID`                 | Cloudflare zone identifier used for DNS and Origin CA operations                                                                                  |

Security keys are automatically generated and persisted by Pulumi on first deployment. Cloudflare secrets remain Worker secrets because they are deployment trust roots. GitHub App/OAuth, GitHub webhook, Google OAuth, GitLab OAuth, analytics forwarding, R2 attachment-upload credentials, devcontainer cache credentials, trial provider keys, and smoke-test auth flags can be supplied as optional Worker secret fallbacks when an installation needs them. Runtime platform values saved through first-run setup or the superadmin platform config UI are stored encrypted in D1 and override environment fallbacks. They never appear in source control. Neither the first-run setup endpoints (`/api/setup/*`) nor the superadmin platform config endpoint (`/api/admin/platform-config`) ever return a secret value: their responses carry only per-field configured/source status, projected by `getPlatformConfigStatus` (`apps/api/src/services/platform-config-status.ts`).

Production deployment secrets are additionally bounded by a GitHub Environment policy that permits deployments from the selected `main` branch only. This external policy is required because a workflow file on another branch cannot be trusted to enforce its own branch check. Automatic deployments also re-resolve the current `main` tip after entering the serialized production deployment queue, so a slower CI run for an older commit cannot roll back a newer deployment.

New VM nodes do not require static `ORIGIN_CA_CERT` or `ORIGIN_CA_KEY` Worker secrets. If those legacy secrets exist from an older deployment, remove them after draining old nodes and confirming the per-node CSR model is deployed.

### Platform Integration Credentials

Admin-managed integration secrets stored encrypted in D1:

| Credential                       | Purpose                                                    | Resolution order                                               |
| -------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| GitHub OAuth client secret       | GitHub sign-in and OAuth refresh                           | Runtime D1 → Worker env → unset                                |
| GitHub App private key           | Installation tokens for repository access                  | Runtime D1 → Worker env → unset                                |
| GitHub webhook secret            | GitHub App webhook HMAC verification                       | Runtime D1 → Worker env → unset                                |
| Google login OAuth client secret | Google sign-in (BetterAuth social login)                   | Runtime D1 → Worker env (`GOOGLE_LOGIN_CLIENT_SECRET`) → unset |
| GitLab OAuth client secret       | GitLab sign-in and repository access                       | Runtime D1 → Worker env (`GITLAB_CLIENT_SECRET`) → unset       |
| Google infra OAuth client secret | Keyless GCP/WIF authorization (separate client from login) | Runtime D1 → Worker env (`GOOGLE_CLIENT_SECRET`) → unset       |

#### Propagation delay after a change

Resolving the table above costs 13 D1 queries and runs on the authentication preamble of every
authenticated request, so the result is cached in memory per Worker isolate for
`PLATFORM_CONFIG_CACHE_MS` (default 60 seconds — see the
[configuration reference](/docs/reference/configuration/)).

The isolate that performs a change drops its own cache immediately, so an admin always sees their
own write. **Other warm isolates continue serving the previous values for up to the configured
TTL.** When rotating a credential in response to a suspected compromise, treat the old value as
still live for that window; revoke it at the provider (GitHub, Google, GitLab) rather than relying
on the SAM-side change alone. Setting `PLATFORM_CONFIG_CACHE_MS=0` disables the cache entirely at
the cost of 13 extra D1 queries per authenticated request.

### User Credentials

User-provided secrets stored encrypted in D1:

| Credential                      | Purpose                                                                                                        | Encryption                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Cloud provider credentials      | VM provisioning (Hetzner, Scaleway, Vultr, Infomaniak, DigitalOcean, UpCloud, GCP WIF or service-account JSON) | AES-256-GCM, per-credential IV |
| Agent API keys                  | Claude, OpenAI, Gemini, and other agent access                                                                 | AES-256-GCM, per-credential IV |
| Agent OAuth tokens              | Claude Pro/Max, Codex subscriptions                                                                            | AES-256-GCM, per-credential IV |
| Composable credentials (`cc_*`) | Reusable credential + configuration attachments layered per project/profile                                    | AES-256-GCM, per-credential IV |

Cloud provider credentials are stored with a `credentialType` of `cloud-provider`. GCP can use recommended keyless WIF or an OAuth-free service-account JSON key for VM provisioning. User credentials are **never** stored as environment variables or Worker secrets.

## Authentication Flow

SAM uses **BetterAuth** with configured OAuth login providers for user authentication:

1. User clicks a configured sign-in provider such as GitHub, Google, or GitLab
2. API redirects to that provider's OAuth flow
3. The provider returns an authorization code
4. API exchanges code for access token
5. API fetches user profile and email
6. BetterAuth creates/updates user record and session
7. Session cookie set in browser

### Token Types

| Token           | Lifetime             | Purpose                          | Validated By            |
| --------------- | -------------------- | -------------------------------- | ----------------------- |
| Session cookie  | Hours                | Browser authentication           | API Worker (BetterAuth) |
| Workspace JWT   | Minutes              | Terminal WebSocket auth          | VM Agent (via JWKS)     |
| Bootstrap token | 5 minutes            | One-time VM credential injection | API Worker              |
| Callback token  | 24 hours (renewable) | VM Agent → API callbacks         | API Worker              |

### Callback Tokens

VM agents call the API Worker with RS256 callback tokens signed by the Worker (`apps/api/src/services/jwt.ts`). There are two scopes, and neither can stand in for the other:

- **Node tokens** (`scope: node`) authenticate node-level callbacks such as heartbeats and error reports. They are renewed in the heartbeat response while the node is not terminal (`apps/api/src/routes/node-lifecycle.ts`).
- **Workspace tokens** (`scope: workspace`) authenticate everything about one workspace: chat messages, session snapshots, git credentials, runtime assets, task status and ACP activity. The Worker hands one to the node when it creates or restores the workspace.

Both last `CALLBACK_TOKEN_EXPIRY_MS` (24 hours by default). A workspace token is renewed without ever leaving its workspace's scope:

1. **Renewal.** After each successful heartbeat, the VM agent renews workspace tokens that are past `CALLBACK_TOKEN_REFRESH_THRESHOLD_RATIO` of their lifetime by calling `POST /api/workspaces/:id/callback-token/renew` with two proofs: the workspace's current, unexpired token and the node's own token. The Worker renews only when D1 binds the workspace to that node, the node belongs to the workspace's owner, and both are still active (`apps/api/src/services/workspace-callback-token-renewal.ts`). A node token alone cannot obtain a workspace token, a workspace token copied out of a devcontainer cannot renew itself, and an expired token is never renewed.
2. **Delivery.** When the Worker asks a VM node to snapshot a session for sleep, the request carries a fresh workspace token over the authenticated node-management channel, the same way workspace creation does. It is minted only if the workspace is still active on that node, and never for Instant containers, which receive a fresh token on every cold wake.

Deleting, stopping or moving a workspace ends renewal, so its callback authority still lapses within one token lifetime. A renewed token keeps its first issue time in a `gen_iat` claim, so the Instant stale-callback guard still recognizes a callback from a replaced container (`apps/api/src/routes/_stale-callback-guard.ts`).

Credentials that an agent process received when it started, such as the SAM AI proxy key, are not rotated inside the running process; the process picks up the current token the next time it starts.

Deletion-in-progress callbacks fail closed. A VM delete timeout is treated as
uncertainty, so the workspace remains `stopping` and callback routes reject its
normal effects. SAM records only throttled, bounded metadata (callback kind,
workspace/node identifiers, and rejection state); request bodies, prompts,
tool output, repository data, and credentials are never copied into this signal.

Destructive runtime requests are bound to a server-written node incarnation, the
exact provider credential reference used for provisioning, and a SHA-256
fingerprint of that encrypted credential generation. The fingerprint prevents a
later in-place credential rotation from redirecting teardown to a different
provider account whose VM identifier happens to collide. SAM rechecks the
workspace, node owner, project/session ownership, provider instance, and runtime
incarnation immediately before a VM-agent deletion request. Managed provider
teardown fails closed when a legacy node has no exact provider-account binding;
it never substitutes whichever credential happens to be active later.

## Credential Encryption

User credentials are encrypted at rest using **AES-256-GCM**:

```
Encrypt: plaintext + ENCRYPTION_KEY → { ciphertext, iv }  (stored in D1)
Decrypt: { ciphertext, iv } + ENCRYPTION_KEY → plaintext   (on-demand)
```

Each credential gets a random initialization vector (IV), ensuring identical plaintext values produce different ciphertext.

### GCP credential handling

GCP WIF configuration and uploaded service-account JSON use the same versioned credential boundary. Existing unversioned WIF records are normalized when read. Service-account JSON is validated as a Google `service_account` key with an importable PKCS#8 RSA private key; uploaded `token_uri` and other endpoint fields are ignored.

The complete source credential is encrypted at rest with AES-256-GCM. SAM signs short-lived RS256 assertions and exchanges them only at the fixed Google OAuth token endpoint. Derived Google access tokens are cached in KV only until their returned expiry minus a safety buffer; they are never persisted as primary credentials. Cache identity includes the authentication mode and WIF or private-key identity, so switching modes or rotating a key cannot reuse a prior token.

Save and rotation verify the selected Compute zone before a D1 transaction replaces both legacy and composable credential copies. A failed verification or transaction leaves the previous credential intact. Disconnect removes SAM's encrypted copies and cached derivatives but does not revoke a Google-managed service-account key.

## Terminal Authentication

Terminal WebSocket connections use short-lived JWTs:

1. Browser requests a terminal token: `POST /api/terminal/token`
2. API signs a JWT with the workspace ID and user ID
3. Browser connects: `wss://ws-{id}.domain/workspaces/{id}/shell?token=...`
4. Worker proxies the WebSocket to the VM Agent
5. VM Agent validates the JWT against the API's JWKS endpoint (`/.well-known/jwks.json`)

## Bootstrap Security

When a new VM starts, cloud-init receives only the short-lived bootstrap/callback material needed to contact the control plane; long-lived provider and repository credentials are fetched through the bootstrap exchange:

1. API creates a one-time bootstrap token (cryptographically random, 15-minute default expiry)
2. Cloud-init starts the VM Agent with control-plane metadata and stores callback JWT material in a root-only file rather than the systemd environment
3. VM Agent redeems the token: `POST /api/bootstrap/{token}`
4. API returns the full configuration and encrypted credential payloads needed for the node
5. Token is invalidated after use

## VM TLS Certificates

New nodes use per-node Origin CA key material rather than a platform-shared private key:

1. The API Worker passes a node-scoped certificate endpoint into cloud-init (`apps/api/src/services/nodes.ts`).
2. Cloud-init generates `/etc/sam/tls/origin-ca-key.pem` locally on the VM, creates a CSR, and posts only that CSR to `POST /api/nodes/:id/origin-ca-certificate` with the node callback JWT (`packages/cloud-init/src/template.ts`).
3. The API Worker verifies the callback token is node-scoped and matches `:id`, then signs the CSR through Cloudflare Origin CA using `CF_API_TOKEN` (`apps/api/src/routes/node-lifecycle.ts`, `apps/api/src/services/origin-ca-certificates.ts`).
4. The VM stores the returned certificate at `/etc/sam/tls/origin-ca.pem` and starts the VM agent with `TLS_CERT_PATH` and `TLS_KEY_PATH`.

The certificate hostnames remain wildcard-scoped (`*.BASE_DOMAIN`, `*.vm.BASE_DOMAIN`, and `BASE_DOMAIN`) so existing `ws-*` and `{node}.vm` routing continues to work. The private key is no longer shared across nodes or embedded in static cloud-init user-data. Each node receives a distinct private key and short-lived certificate, with `ORIGIN_CA_CERT_VALIDITY_DAYS` defaulting to 7 days.

### Legacy Origin CA Rotation

Deployments created before the per-node CSR model may have running nodes that still hold a broadly distributed wildcard `ORIGIN_CA_KEY`. Rotate that legacy material by draining or deleting old nodes, deploying the per-node certificate model, revoking the old wildcard Origin CA certificate in Cloudflare SSL/TLS → Origin Server, and removing any manually configured `ORIGIN_CA_CERT`/`ORIGIN_CA_KEY` Worker secrets. New nodes do not require those Worker secrets.

## Interactive HTML Preview Isolation

Interactive previews are a no-network execution tier for single-file HTML library artifacts:

1. The authenticated app requests a short-lived URL only after project access and file scope are checked (`apps/api/src/routes/library.ts`).
2. The API signs the project, file, file version, and expiry into a path prefix with a deployment-owned HMAC key (`apps/api/src/services/interactive-preview.ts`).
3. `preview.BASE_DOMAIN` is dispatched before session middleware. It never reads session cookies (`apps/api/src/index.ts`, `apps/api/src/routes/interactive-preview-host.ts`).
4. Every response CSP includes `sandbox allow-scripts`, giving scripts an opaque origin even when opened directly, and denies connections, workers, objects, base URLs, and forms.
5. The app renders an `allow-scripts`-only iframe sandbox. Same-origin, forms, popups, downloads, and top navigation are never granted.

The preview starts as soon as a user opens the artifact (`apps/web/src/components/library/InteractiveHtmlPreview.tsx`). Opening the file is itself the deliberate user action — scripts still never execute passively while scrolling a chat timeline, because the document card only mounts the preview once clicked (`apps/web/src/components/project-message-view/tool-cards/DocumentCard.tsx`). The isolation above, not a confirmation prompt, is what contains the artifact: it runs on a separate origin with an opaque origin, no cookies or storage in scope, and no network egress, so there is no credential or exfiltration path to consent to.

The dedicated origin contains iframe-policy regressions; the CSP sandbox header protects direct-open links. Preview is deliberately absent from credentialed CORS and BetterAuth trusted origins, and responses never set cookies.

## Agent-Written Files and Diagrams

Library files, repository files, workspace files, and chat messages can all be written by agents, so everything the API hands a browser from them is treated as untrusted. The serving policy lives in `apps/api/src/services/file-serving-policy.ts`.

**Inline previews** (`GET /api/projects/:id/library/:fileId/preview`):

- Only images, PDFs, markdown, and HTML (served as inert `text/plain`) preview inline. Every response is `nosniff`, and no preview CSP allows script.
- `frame-ancestors` names the app origin (`https://app.BASE_DOMAIN`, from `appFrameAncestors` in `apps/api/src/lib/app-origin.ts`). Previews come from the API origin, so `'self'` or `X-Frame-Options: SAMEORIGIN` would block the app's own PDF viewer.
- Only a PDF gets the looser policy the browser's viewer needs (`object-src 'self'`, inline styles). It gets it only when its bytes start with the `%PDF-` signature; a file that merely claims to be a PDF is refused.
- The app frames PDFs without an iframe `sandbox`, because Chromium refuses to render a PDF inside any sandboxed frame. The response headers above keep that frame inert (`apps/web/src/components/library/FilePreviewModal.tsx`).
- A browser's PDF viewer runs a PDF's own scripts in its own engine, which no response header governs. In Chromium, such a script can show an alert, but its actions that open a URL, submit a form, or fetch one made no request in testing.

**Downloads** (`/download`) are always `Content-Disposition: attachment` with `nosniff`. The stored type is sent only when it is exactly one well-formed media type that a browser cannot execute. Anything else is served as `application/octet-stream`, whatever parameters it carries: HTML, XML and `+xml` types, JavaScript, comma-separated lists, and malformed values.

**Raw files** from the repository browser (`GET /api/projects/:id/repo/raw`) and from a chat session's workspace (`GET /api/projects/:id/sessions/:sessionId/files/raw`) carry `nosniff` and a sandboxing CSP, so any document they render is inert: no script, no fetches, no automatic navigation, and an opaque origin. Opened directly, active types (HTML, SVG and other XML, JavaScript) download instead of rendering. Images embedded with `<img>` are unaffected.

**Mermaid diagrams** in chat and in library markdown render through one pipeline (`renderMermaidSvg` in `packages/acp-client/src/mermaid.ts`):

- Mermaid draws labels as SVG text, so its output contains no `<foreignObject>` or HTML. A diagram's own directives cannot re-enable HTML labels, inject CSS (`themeCSS`, `fontFamily`), or make marker references absolute. Features that can only draw text as HTML lose that text: Venn member lists, architecture text icons, and KaTeX math.
- The SVG is sanitized to an SVG-only allowlist in which every reference stays inside the document. An `href` must be a `#fragment`, or an inline raster image on `<image>`. CSS that names a remote resource is dropped.

Mermaid lays a diagram out in the live page before it is sanitized, so a remote image named in diagram syntax can still be fetched once while the diagram renders. Markdown images (`![](…)`) are also shown as written. A platform-wide policy for remote resources in agent content, including scripts inside previewed PDFs, is tracked separately.

## Secret Redaction in Logs and Diagnostics

Credential tokens are stripped before text reaches a log line or a stored diagnostic: OpenAI and Anthropic `sk-...` keys (including `sk-proj-...` and `sk-ant-...`), GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), and SAM personal access and webhook tokens. Every API redactor takes these token shapes from one definition, `redactCredentialTokens` in `apps/api/src/lib/credential-token-redaction.ts`: structured Worker logs (`apps/api/src/lib/logger.ts`), stored VM agent error reports and debug-agent evidence (`redactSensitiveData`), comment directives delivered to agents, deployment publish and apply events, Report Issue text, and agent sign-in helper diagnostics. `Bearer ...` and `Basic ...` values are matched by each redactor's own rule, because those are also ordinary words and a log line can afford to over-redact where text shown to a user cannot. Redaction is pattern-based and best-effort - a safety net, not a reason to paste secrets anywhere.

## Security Best Practices

- **Rotate keys quarterly** — regenerate JWT and encryption keys
- **Minimal GitHub App permissions** — only Contents (read/write), Metadata (read-only), and Email addresses (read-only)
- **HTTPS everywhere** — all traffic encrypted via Cloudflare
- **Session isolation** — each workspace JWT is scoped to a specific workspace ID
- **Per-user credential isolation** — each user's cloud/agent secrets are encrypted with a per-credential IV and are never shared between users

:::caution
Rotating the credential-encryption key will make existing encrypted credentials unreadable. Users will need to reconnect cloud credentials—including any GCP service-account JSON—and re-enter agent API keys after key rotation.
:::
