# Environment Variables & URL Construction

## Environment Variable Naming

GitHub secrets and Cloudflare Worker secrets use DIFFERENT naming conventions. Confusing them causes deployment failures.

| Context                | Prefix    | Example            | Where Used                                    |
| ---------------------- | --------- | ------------------ | --------------------------------------------- |
| **GitHub Environment** | `GH_`     | `GH_CLIENT_ID`     | GitHub Settings -> Environments -> production |
| **Cloudflare Worker**  | `GITHUB_` | `GITHUB_CLIENT_ID` | Worker runtime, local `.env` files            |

### Why Different Names?

GitHub Actions secret names cannot start with `GITHUB_*`. So we use `GH_*` in GitHub, and `configure-secrets.sh` maps them to `GITHUB_*` Worker secrets.

### The Mapping (done by `configure-secrets.sh`)

```
GitHub Secret          ->  Cloudflare Worker Secret
GH_CLIENT_ID           ->  GITHUB_CLIENT_ID
GH_CLIENT_SECRET       ->  GITHUB_CLIENT_SECRET
GH_APP_ID              ->  GITHUB_APP_ID
GH_APP_PRIVATE_KEY     ->  GITHUB_APP_PRIVATE_KEY
GH_APP_SLUG            ->  GITHUB_APP_SLUG
GH_WEBHOOK_SECRET      ->  GITHUB_WEBHOOK_SECRET
```

### Documentation Rules

1. **GitHub Environment config** -> Use `GH_*` prefix
2. **Cloudflare Worker secrets** -> Use `GITHUB_*` prefix
3. **Local `.env` files** -> Use `GITHUB_*` prefix (same as Worker)
4. ALWAYS specify which context you're documenting
5. NEVER mix prefixes in the same table without explanation

### Quick Reference

- **User configuring GitHub**: Tell them to use `GH_CLIENT_ID`
- **Code reading from env**: Use `env.GITHUB_CLIENT_ID`
- **Local development**: Use `GITHUB_CLIENT_ID` in `.env`
- **GitHub webhook secret**: Tell them to use `GH_WEBHOOK_SECRET` in GitHub and `GITHUB_WEBHOOK_SECRET` in Worker/local env

## Wrangler Environment Sections (Generated at Deploy Time)

Environment-specific sections (`[env.staging]`, `[env.production]`) are NOT checked into the repository. They are generated dynamically at deploy time by `scripts/deploy/sync-wrangler-config.ts`, which:

1. Reads Pulumi stack outputs for dynamic bindings (D1 IDs, KV IDs, R2 bucket names)
2. Copies static bindings from the top-level config (Durable Objects, AI, migrations)
3. Derives worker names from `DEPLOYMENT_CONFIG` in `scripts/deploy/config.ts`
4. Conditionally adds `tail_consumers` (only if the tail worker already exists)

### Required action when adding a new binding

Add the binding to the **top-level section of `wrangler.toml` only**. The sync script handles the rest.

- **Static bindings** (Durable Objects, AI, migrations): Copied verbatim from top-level to generated env sections.
- **Dynamic bindings** (D1, KV, R2): Generated from Pulumi outputs with correct resource IDs per environment.
- **Derived bindings** (worker name, routes, tail_consumers): Computed from `DEPLOYMENT_CONFIG` naming conventions.

The CI quality check (`pnpm quality:wrangler-bindings`) verifies:

1. No `[env.*]` sections exist in checked-in `wrangler.toml` files
2. All required binding types are present at the top level

### Why this architecture

Wrangler does NOT inherit bindings (D1, KV, R2, DO, AI, tail_consumers) from top-level into `[env.*]` sections. Previously, this required manually duplicating every binding 3x (top-level + staging + production). Now the sync script generates complete env sections, eliminating duplication and making the config fork-friendly.

### Why tests don't catch binding issues

Miniflare (used in Vitest worker tests) configures bindings directly in `vitest.workers.config.ts`, NOT from `wrangler.toml`. Tests will pass even when wrangler.toml is misconfigured.

### Workers Secrets

```bash
wrangler secret put SECRET_NAME
```

Local development uses `.dev.vars`.

**Note**: Hetzner tokens are NOT platform secrets. Users provide their own tokens through the Settings UI, stored encrypted per-user in the database. See `docs/architecture/credential-security.md`.

## URL Construction Rules

When constructing URLs using `BASE_DOMAIN`, you MUST use the correct subdomain prefix. The root domain does NOT serve any application.

| Destination   | URL Pattern                       | Example                                         |
| ------------- | --------------------------------- | ----------------------------------------------- |
| **Web UI**    | `https://app.${BASE_DOMAIN}/...`  | `https://app.simple-agent-manager.org/settings` |
| **API**       | `https://api.${BASE_DOMAIN}/...`  | `https://api.simple-agent-manager.org/health`   |
| **Workspace** | `https://ws-${id}.${BASE_DOMAIN}` | `https://ws-abc123.simple-agent-manager.org`    |

**NEVER** use `https://${BASE_DOMAIN}/...` (bare root domain) for redirects or links.

### Redirect Rules

- All user-facing redirects (e.g., after GitHub App installation, after login) MUST go to `app.${BASE_DOMAIN}`
- All API-to-API references MUST use `api.${BASE_DOMAIN}`
- Relative redirects (e.g., `c.redirect('/settings')`) are WRONG in the API worker — they resolve to the API subdomain, not the app subdomain
