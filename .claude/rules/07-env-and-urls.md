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
