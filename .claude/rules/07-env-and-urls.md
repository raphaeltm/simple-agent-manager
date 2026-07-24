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
6. Distinguish manual GitHub Environment prerequisites from generated Worker secrets

### Quick Reference

- **User configuring GitHub**: Tell them to use `GH_CLIENT_ID`
- **Code reading from env**: Use `env.GITHUB_CLIENT_ID`
- **Local development**: Use `GITHUB_CLIENT_ID` in `.env`
- **GitHub webhook secret**: Tell them to use `GH_WEBHOOK_SECRET` in GitHub and `GITHUB_WEBHOOK_SECRET` in Worker/local env

## Generated Platform Secrets

Do not ask users to supply platform-owned signing/encryption material when SAM can safely generate and persist it during deployment.

Examples:

- `ENCRYPTION_KEY`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `DEPLOY_SIGNING_PRIVATE_KEY`, `DEPLOY_SIGNING_PUBLIC_KEY`, and `TRIAL_CLAIM_TOKEN_SECRET` are Worker runtime secrets, not required manual GitHub Environment secrets for fresh installs.
- `ORIGIN_CA_CERT` and `ORIGIN_CA_KEY` are legacy rotation inputs only. New VM nodes generate Origin CA private keys locally and fetch signed certificates through the node-scoped callback endpoint.
- Pulumi persists the generated source key material; `scripts/deploy/configure-secrets.sh` derives any runtime public keys and copies the resulting values into Cloudflare Worker secrets.
- GitHub Environment secrets with the same names are compatibility/rotation overrides only. When adding new deployment-owned secrets, prefer Pulumi generation plus an explicit override path over a new manual prerequisite.

## Wrangler Environment Sections (Generated at Deploy Time)

Environment-specific sections (`[env.staging]`, `[env.production]`) are NOT checked into the repository. They are generated dynamically at deploy time by `scripts/deploy/sync-wrangler-config.ts`, which:

1. Reads Pulumi stack outputs for dynamic bindings (D1 IDs, KV IDs, R2 bucket names)
2. Copies static Durable Object and AI bindings, then resolves Durable Object migrations against the target Worker's deployed tag
3. Derives worker names from `DEPLOYMENT_CONFIG` in `scripts/deploy/config.ts`
4. Conditionally adds `tail_consumers` (only if the tail worker already exists)

### Required action when adding a new binding

Add the binding to the **top-level section of `wrangler.toml` only**. The sync script handles the rest.

- **Static bindings** (Durable Objects, AI): Copied verbatim from top-level to generated env sections.
- **Durable Object migrations**: The applied prefix is copied verbatim; only pending legacy `new_classes` creates are emitted as `new_sqlite_classes`.
- **Dynamic bindings** (D1, KV, R2): Generated from Pulumi outputs with correct resource IDs per environment.
- **Derived bindings** (worker name, routes, tail_consumers): Computed from `DEPLOYMENT_CONFIG` naming conventions.

### Durable Object migration safety

- Applied migration tags are immutable history. Never rewrite an applied `new_classes`, rename, delete, or transfer entry to change storage or behavior.
- New Durable Object namespaces MUST use `new_sqlite_classes`.
- The sync script MUST confirm whether the target Worker is absent or read its deployed `migration_tag` before generating an environment.
- A missing, unreadable, duplicated, or unknown migration tag MUST fail the deployment preflight. Never assume an ambiguous Worker is a clean install; Wrangler can otherwise submit the full local history. The probe retries transient failures a bounded number of times (`DO_MIGRATION_STATE_PROBE_ATTEMPTS`, `DO_MIGRATION_STATE_PROBE_RETRY_DELAY_MS`) before failing closed.
- The `[[migrations]]` array is append-only with sequential `v1..vN` tags. The resolver (and Wrangler) treat array position relative to the deployed tag as the applied/pending boundary, so inserting or reordering entries silently corrupts that boundary. The compatibility test suite enforces the sequence and runs in the `Validate Deploy Scripts` CI job (`scripts/quality/do-migration-compatibility.test.ts`).
- Wrangler resolves `migrations` via its `inheritable()` config path: if `env.*.migrations` were ever omitted, Wrangler silently falls back to the top-level (legacy) array with NO "not inherited by environments" warning — the deploy grep-guard does not protect this field. The generated-environment test pins that `env.*.migrations` is always emitted.
- Test both a clean bootstrap and an existing deployment at the latest historical tag whenever migration generation changes. Miniflare alone does not exercise the remote migration contract.

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

**Note**: Hetzner tokens are NOT platform secrets. Users provide their own tokens through the Settings UI, stored encrypted per-user in the database. See `apps/www/src/content/docs/docs/architecture/security.md`.

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
