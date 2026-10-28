# SAM installer prototype

An independent Cloudflare Worker with static assets and its own session Durable Object. It does not share SAM API, marketing scripts, data bindings, or login sessions.

**Current capability:** Cloudflare OAuth → choose account → create a protected maintenance Worker → verify owner handoff → clear hosted credentials. It does **not** build/install the full SAM application or implement updates yet. No ongoing Cloudflare authority is transferred to the maintenance Worker.

Public user instructions: [Installer guide](https://www.simple-agent-manager.org/docs/guides/installer/). Source for that guide is `apps/www/src/content/docs/docs/guides/installer.mdx`.

## Deploy your own installer

Requires Node 22+, pnpm 9.15.9, a Cloudflare account with Workers Paid (SQLite Durable Objects), an active domain in that account, and an API token with Account Settings Read, Workers Scripts Edit, OAuth Client Write, and the zone permissions needed for Workers Custom Domains. Use the smallest account/zone scope possible. Consult Cloudflare's current permission names when creating the token.

```sh
pnpm install --frozen-lockfile
# Supply credentials through your shell's secret manager; do not commit them.
export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID
export BASE_DOMAIN=example.com
pnpm --filter @simple-agent-manager/installer deploy
```

The script deploys `sam-installer-self-hosted` at `https://install.example.com`, creates a private OAuth client if none exists, and uploads its client ID/secret directly as Worker secrets. Reruns preserve the client and secret. `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` can override an existing client; configure its callback as `https://install.example.com/oauth/callback`. A failed secret write after client creation requires supplying/rotating the client secret before rerunning. Secrets are never printed or written to disk by the script.

Private OAuth clients are usable by members of their parent account. To serve other users, follow Cloudflare's [publisher verification and public promotion](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/). Public promotion is permanent and intentionally not automated.

## Development

`pnpm --filter @simple-agent-manager/installer dev` serves localhost:8787. Register a development OAuth client with `http://localhost:8787/oauth/callback`, then place `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` in gitignored `.dev.vars`. Never use production tokens in UI fixtures. Run `typecheck`, `lint`, `test`, and `build` with the same package filter.

Variables: `APP_ORIGIN` (exact origin), `SESSION_TTL_SECONDS` (60–3600, default 900), `OAUTH_SCOPES`, `SOURCE_URL`, `DOCS_URL`, `BUILD_SHA`. Deployment uses `BASE_DOMAIN`, `INSTALLER_ENVIRONMENT` (default self-hosted), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`; optional source/docs URL overrides. Provider API origins and protocol parameters are constants, not configurable proxy destinations.

## Repository deployment

`deploy-installer.yml` only runs in `raphaeltm/simple-agent-manager`. Pushes changing `apps/installer/**` on `sam/**` deploy staging; main deploys production. It can also be manually dispatched; production is restricted to main. Workflow-only/docs-only changes do not automatically deploy. It uses existing GitHub `staging`/`production` secrets `CF_API_TOKEN`, `CF_ACCOUNT_ID`, and variable `BASE_DOMAIN`. It does not invoke the main SAM deployment. Both environments default to a private OAuth client until explicit promotion.

## Security and lifecycle

Authorization codes use state and PKCE. The server stores tokens in an isolated expiring DO session, never localStorage. Browser gets a random HttpOnly session cookie. Account IDs are constrained to the provider's authorized account list; jobs bind to one account and use stable generated resource names. No arbitrary API proxy or arbitrary callback destination exists. Callback consumption precedes exchange. Sessions expire on access and via alarm, with best-effort token revocation on disconnect/handoff/expiry. Cloudflare authorization can also be revoked in the owner's profile.

The bootstrap Worker accepts a short-lived owner credential by POST from the installer origin. Its secret stores only the credential hash. This is temporary prototype access, not a durable admin identity. Created Workers are deliberately retained; users delete them in Cloudflare. No claim of automatic rollback or zero provider logging is made. Application observability is disabled to avoid persisting callback URLs. A hosted operator can change code; separate deployment is not trustlessness.
