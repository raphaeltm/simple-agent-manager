# Environment Variables & URL Construction

## Environment Variable Naming

GitHub secrets and Cloudflare Worker secrets use DIFFERENT naming conventions. Confusing them causes deployment failures.

| Context | Prefix | Example | Where Used |
|---------|--------|---------|------------|
| **GitHub Environment** | `GH_` | `GH_CLIENT_ID` | GitHub Settings -> Environments -> production |
| **Cloudflare Worker** | `GITHUB_` | `GITHUB_CLIENT_ID` | Worker runtime, local `.env` files |

### Why Different Names?

GitHub Actions reserves `GITHUB_*` for its own use. So we use `GH_*` in GitHub, and `configure-secrets.sh` maps them to `GITHUB_*` Worker secrets.

### The Mapping (done by `configure-secrets.sh`)

```
GitHub Secret          ->  Cloudflare Worker Secret
GH_CLIENT_ID           ->  GITHUB_CLIENT_ID
GH_CLIENT_SECRET       ->  GITHUB_CLIENT_SECRET
GH_APP_ID              ->  GITHUB_APP_ID
GH_APP_PRIVATE_KEY     ->  GITHUB_APP_PRIVATE_KEY
GH_APP_SLUG            ->  GITHUB_APP_SLUG
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

## Wrangler Non-Inheritable Bindings

Wrangler does NOT inherit certain binding types from the top-level config into `[env.*]` sections. When deploying with `--env production` or `--env staging`, bindings defined only at the top level will be **undefined** at runtime.

### Non-inheritable binding types (MUST be duplicated per environment)

- `durable_objects.bindings` — Durable Object bindings
- `ai` — Workers AI binding
- `d1_databases` — D1 database bindings
- `kv_namespaces` — KV namespace bindings
- `r2_buckets` — R2 bucket bindings
- `tail_consumers` — Tail Worker consumers

### Required action when adding ANY new binding

When adding a new binding to `wrangler.toml`, you MUST add it to ALL THREE places:

1. **Top-level** — used by local dev and Miniflare tests
2. **`[env.staging]`** — used by `wrangler deploy --env staging`
3. **`[env.production]`** — used by `wrangler deploy --env production`

Failure to do this causes `env.BINDING_NAME` to be `undefined` at runtime, producing `Cannot read properties of undefined (reading 'idFromName')` or similar errors that only appear in deployed environments, never in local tests.

### Why tests don't catch this

Miniflare (used in Vitest worker tests) configures bindings directly in `vitest.workers.config.ts`, NOT from `wrangler.toml`. Tests will pass even when wrangler.toml is misconfigured.

### Workers Secrets

```bash
wrangler secret put SECRET_NAME
```

Local development uses `.dev.vars`.

**Note**: Hetzner tokens are NOT platform secrets. Users provide their own tokens through the Settings UI, stored encrypted per-user in the database. See `docs/architecture/credential-security.md`.

## URL Construction Rules

When constructing URLs using `BASE_DOMAIN`, you MUST use the correct subdomain prefix. The root domain does NOT serve any application.

| Destination | URL Pattern | Example |
|-------------|-------------|---------|
| **Web UI** | `https://app.${BASE_DOMAIN}/...` | `https://app.simple-agent-manager.org/settings` |
| **API** | `https://api.${BASE_DOMAIN}/...` | `https://api.simple-agent-manager.org/health` |
| **Workspace** | `https://ws-${id}.${BASE_DOMAIN}` | `https://ws-abc123.simple-agent-manager.org` |

**NEVER** use `https://${BASE_DOMAIN}/...` (bare root domain) for redirects or links.

### Redirect Rules

- All user-facing redirects (e.g., after GitHub App installation, after login) MUST go to `app.${BASE_DOMAIN}`
- All API-to-API references MUST use `api.${BASE_DOMAIN}`
- Relative redirects (e.g., `c.redirect('/settings')`) are WRONG in the API worker — they resolve to the API subdomain, not the app subdomain
