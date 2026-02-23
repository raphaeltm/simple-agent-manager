# Fix: www and apex domain routing blocked by Worker wildcard route

**Created:** 2026-02-23
**Priority:** High (marketing site is inaccessible)
**Estimated effort:** Small (1-2 hours)

## Problem

`www.simple-agent-manager.org` and `simple-agent-manager.org` (apex) are inaccessible. Both return unexpected responses instead of serving the marketing site.

## Root Cause

The Cloudflare Worker wildcard route `*.simple-agent-manager.org/*` intercepts **all** subdomain traffic, including `www.*`. This is the exact same bug that previously blocked `app.*` (fixed in `52cd931`) and `ws-*.*` (fixed in `81f1dfc`).

### Cloudflare routing priority (discovered through past fixes):

1. **Page Rules** (highest) — apex redirect should work here
2. **Worker Routes** — the `*.domain/*` wildcard catches everything not handled by Page Rules
3. **Pages Custom Domains** — do NOT override Worker routes (learned in `16acc52`, reverted in `52cd931`)
4. **DNS CNAME records** — lowest priority, overridden by Worker routes

### What happens now:

**`www.simple-agent-manager.org`:**
1. DNS: `www` CNAME points to `sam-www.pages.dev` (set by `provision-www.yml`)
2. BUT: the wildcard Worker route `*.simple-agent-manager.org/*` intercepts the request first
3. The Worker has no handler for `www.*` — it falls through to the API router
4. API router returns 404 ("Endpoint not found") or an unexpected response

**`simple-agent-manager.org` (apex):**
1. DNS: A record `192.0.2.1` (proxied) with Page Rule redirect to `www.*`
2. Page Rules have higher priority than Worker routes, so the redirect _should_ fire
3. BUT: if the Page Rule redirects to `www.*`, and `www.*` is broken (see above), the user gets an error anyway
4. Additionally, if `provision-www.yml` was never run, neither the Page Rule nor the www DNS record exist

## How app.* was fixed (the proven pattern)

Commit `52cd931` added a proxy middleware in the Worker that checks for `app.*` hostname and proxies to Pages before any other route processing:

```typescript
// apps/api/src/index.ts — existing middleware (lines ~160-167)
app.use('*', async (c, next) => {
  const hostname = new URL(c.req.url).hostname;
  const baseDomain = c.env?.BASE_DOMAIN || '';
  if (baseDomain && hostname === `app.${baseDomain}`) {
    const pagesUrl = new URL(c.req.url);
    pagesUrl.hostname = `${c.env.PAGES_PROJECT_NAME || 'sam-web-prod'}.pages.dev`;
    return fetch(new Request(pagesUrl.toString(), c.req.raw));
  }
  await next();
});
```

## Fix Plan

### Option A: Add www proxy middleware in the Worker (recommended)

Add a middleware handler for `www.*` in `apps/api/src/index.ts`, placed **before** the existing `app.*` proxy (or alongside it in the same block). This follows the proven pattern.

```typescript
// Add alongside existing app.* proxy middleware
app.use('*', async (c, next) => {
  const hostname = new URL(c.req.url).hostname;
  const baseDomain = c.env?.BASE_DOMAIN || '';
  if (!baseDomain) { await next(); return; }

  // Proxy app.* to web UI Pages project
  if (hostname === `app.${baseDomain}`) {
    const pagesUrl = new URL(c.req.url);
    pagesUrl.hostname = `${c.env.PAGES_PROJECT_NAME || 'sam-web-prod'}.pages.dev`;
    return fetch(new Request(pagesUrl.toString(), c.req.raw));
  }

  // Proxy www.* to marketing site Pages project
  if (hostname === `www.${baseDomain}`) {
    const pagesUrl = new URL(c.req.url);
    pagesUrl.hostname = 'sam-www.pages.dev';
    return fetch(new Request(pagesUrl.toString(), c.req.raw));
  }

  // Redirect apex to www
  if (hostname === baseDomain) {
    const wwwUrl = new URL(c.req.url);
    wwwUrl.hostname = `www.${baseDomain}`;
    return c.redirect(wwwUrl.toString(), 301);
  }

  await next();
});
```

**Advantages:**
- Follows the proven pattern from `52cd931`
- Handles apex redirect in-Worker (doesn't depend on Page Rule existing)
- Single place to manage all subdomain routing logic
- Works regardless of whether `provision-www.yml` has been run

### Option B: Exclude www from the wildcard Worker route

Add an explicit `www.*` route that maps to `null` (no Worker), so traffic goes straight to DNS/Pages.

This does NOT work. Cloudflare has no way to exclude a specific subdomain from a wildcard Worker route. The `16acc52` fix attempted this with Pages Custom Domains and it failed.

### Option C: Make the www Pages project name configurable

Hardcoding `sam-www.pages.dev` violates constitution Principle XI. Add a `WWW_PAGES_PROJECT_NAME` env var (defaulting to `sam-www`), similar to how `PAGES_PROJECT_NAME` works for the app UI.

This should be done alongside Option A.

## Implementation Checklist

- [ ] Add `WWW_PAGES_PROJECT_NAME` to the `Env` interface in `apps/api/src/index.ts`
- [ ] Add `WWW_PAGES_PROJECT_NAME` to `apps/api/.env.example`
- [ ] Update the app/www/apex proxy middleware in `apps/api/src/index.ts` (Option A + C)
- [ ] Add `WWW_PAGES_PROJECT_NAME` to `sync-wrangler-config.ts` env vars (or set via wrangler secret)
- [ ] Add `WWW_PAGES_PROJECT_NAME` to `configure-secrets.sh` if needed
- [ ] Verify `provision-www.yml` has been run at least once (DNS records and Page Rule exist)
- [ ] Deploy to staging and verify:
  - `www.simple-agent-manager.org` serves the marketing site
  - `simple-agent-manager.org` redirects to `www.simple-agent-manager.org`
  - `app.simple-agent-manager.org` still works (no regression)
  - `ws-*.simple-agent-manager.org` still works (no regression)
  - `api.simple-agent-manager.org` still works (no regression)
- [ ] Update docs if needed (env-reference, self-hosting guide)

## Historical Context (git log)

| Commit | Fix | Lesson |
|--------|-----|--------|
| `5567bbd` | Added Worker routes to wrangler.toml | Wrangler needs explicit routes for custom domains |
| `3fc2d91` | Added `/*` to route patterns | Without `/*`, only root path matches |
| `16acc52` | Tried Pages Custom Domain for app.* | Pages Custom Domains do NOT override Worker routes |
| `52cd931` | Added Worker proxy middleware for app.* | The proven fix: proxy in the Worker itself |
| `81f1dfc` | Added Worker proxy for ws-*.* | Same pattern extended to workspace subdomains |
| `d31924a` | Clean proxy headers to avoid CF Error 1003 | Cloudflare internal headers cause routing loops |
| `87b5abd` | Provisioned www Pages infra | Set up DNS + Page Rule, but didn't add Worker proxy |

The gap: `87b5abd` created the www infrastructure but missed the Worker proxy middleware step that `52cd931` established as the required pattern.

## Files to Modify

- `apps/api/src/index.ts` — Add www/apex proxy middleware
- `apps/api/.env.example` — Add `WWW_PAGES_PROJECT_NAME`
- `scripts/deploy/sync-wrangler-config.ts` — Possibly add www env var
- `scripts/deploy/configure-secrets.sh` — Possibly add www env var mapping
