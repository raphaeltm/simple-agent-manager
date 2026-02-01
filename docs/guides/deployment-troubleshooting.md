# Deployment Troubleshooting Guide

This guide helps diagnose and resolve common issues during SAM deployment.

---

## Quick Diagnostics

Run these commands first to understand your deployment state:

```bash
# Check overall deployment health
pnpm validate:setup

# Verify Cloudflare credentials
curl -X GET "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json"

# Check API health
curl https://api.YOUR_DOMAIN.com/health

# Check Web UI
curl -I https://app.YOUR_DOMAIN.com
```

---

## Common Issues

### Authentication Errors

#### "Cloudflare API authentication failed"

**Symptoms:**
- Deployment fails immediately
- Error code: `CF_AUTH_FAILED`

**Causes:**
1. Invalid API token
2. Expired API token
3. Token not copied correctly (whitespace issues)

**Solutions:**

1. Verify token format:
   ```bash
   # Token should be ~40 characters, alphanumeric
   echo $CF_API_TOKEN | wc -c  # Should be ~41 (40 + newline)
   ```

2. Test token directly:
   ```bash
   curl -X GET "https://api.cloudflare.com/client/v4/user/tokens/verify" \
     -H "Authorization: Bearer $CF_API_TOKEN"
   ```

3. Generate new token at [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)

---

#### "API token is missing required permissions"

**Symptoms:**
- Preflight checks fail
- Error code: `CF_MISSING_PERMISSIONS`

**Required Permissions:**

| Scope | Permission | Level |
|-------|------------|-------|
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Account | Workers KV Storage | Edit |
| Account | Workers R2 Storage | Edit |
| Zone | DNS | Edit |

**Solutions:**

1. Edit your existing token or create a new one
2. Add ALL required permissions
3. For Zone permissions, select your specific domain

---

### Resource Creation Errors

#### "Failed to create D1 database"

**Symptoms:**
- Provisioning step fails
- Error code: `D1_CREATE_FAILED`

**Causes:**
1. D1 database limit reached (Free: 10 databases)
2. Missing D1 permission
3. Invalid database name

**Solutions:**

1. Check existing databases:
   ```bash
   npx wrangler d1 list
   ```

2. Delete unused databases if at limit:
   ```bash
   npx wrangler d1 delete database-name
   ```

3. Verify name follows rules:
   - 3-64 characters
   - Alphanumeric and hyphens only
   - Start with letter

---

#### "Failed to create KV namespace"

**Symptoms:**
- Provisioning step fails
- Error code: `KV_CREATE_FAILED`

**Causes:**
1. KV namespace limit reached (Free: 100 namespaces)
2. Missing KV permission

**Solutions:**

1. Check existing namespaces:
   ```bash
   npx wrangler kv:namespace list
   ```

2. Delete unused namespaces

---

#### "Failed to create R2 bucket"

**Symptoms:**
- Provisioning step fails
- Error code: `R2_CREATE_FAILED`

**Causes:**
1. Bucket name already exists (globally unique)
2. Invalid bucket name
3. Missing R2 permission

**Solutions:**

1. Try a different bucket name or add environment suffix
2. Check name rules:
   - 3-63 characters
   - Lowercase letters, numbers, hyphens
   - Start/end with letter or number

---

### DNS Errors

#### "Zone not found"

**Symptoms:**
- DNS configuration fails
- Error code: `DNS_ZONE_NOT_FOUND`

**Causes:**
1. Wrong Zone ID
2. Domain not active in Cloudflare
3. Domain paused

**Solutions:**

1. Verify Zone ID:
   - Go to Cloudflare Dashboard
   - Select your domain
   - Find Zone ID in right sidebar

2. Check domain status:
   ```bash
   curl -X GET "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID" \
     -H "Authorization: Bearer $CF_API_TOKEN"
   ```

---

#### "DNS record already exists"

**Symptoms:**
- DNS step reports conflict
- Records exist with different content

**Solutions:**

1. The deployment will update existing records automatically
2. To start fresh, delete existing records in Cloudflare Dashboard:
   - `api.your-domain.com`
   - `app.your-domain.com`
   - `*.your-domain.com`

---

### Deployment Errors

#### "Worker deployment failed"

**Symptoms:**
- Deploy step fails
- Build errors

**Solutions:**

1. Check local build first:
   ```bash
   cd apps/api
   pnpm build
   ```

2. Verify wrangler.toml configuration

3. Check for TypeScript errors:
   ```bash
   pnpm typecheck
   ```

---

#### "Pages deployment failed"

**Symptoms:**
- Pages deploy step fails
- Project not found error

**Solutions:**

1. For new projects, deployment auto-creates the project
2. If it fails, create manually:
   ```bash
   npx wrangler pages project create workspaces-web --production-branch main
   ```

---

### Health Check Failures

#### "API endpoint unhealthy"

**Symptoms:**
- Health check shows API failing
- 502/504 errors

**Causes:**
1. Worker not deployed
2. Worker crashed on startup
3. Missing environment variables

**Solutions:**

1. Check Worker logs:
   ```bash
   cd apps/api
   npx wrangler tail
   ```

2. Verify secrets are set:
   ```bash
   npx wrangler secret list
   ```

3. Redeploy:
   ```bash
   pnpm deploy:setup --resume
   ```

---

#### "Web UI unhealthy"

**Symptoms:**
- Health check shows Web failing
- 404 errors

**Causes:**
1. Pages not deployed
2. DNS not pointing correctly
3. Build failure

**Solutions:**

1. Verify Pages deployment:
   ```bash
   cd apps/web
   npx wrangler pages deployment list
   ```

2. Check build output exists:
   ```bash
   ls apps/web/dist/
   ```

---

### Resume & Recovery

#### Resuming a Failed Deployment

If deployment fails partway through:

```bash
# Resume from last successful step
pnpm deploy:setup --resume

# Or start fresh (deletes state file)
pnpm deploy:setup
```

#### Checking Deployment State

```bash
# View state file
cat .wrangler/state/deployment-production.json
```

The state file shows:
- Which steps completed
- Resource IDs created
- Any errors encountered

#### Full Reset

To completely restart:

```bash
# Remove all resources
pnpm teardown:setup --force

# Clear state
rm -rf .wrangler/state/

# Deploy fresh
pnpm deploy:setup
```

---

## Environment-Specific Issues

### GitHub Actions

#### "Secrets not found"

Ensure all required secrets are set in your repository:
1. Settings → Secrets and variables → Actions
2. Add repository secrets (not environment secrets)

Required secrets:
- `CF_API_TOKEN`
- `CF_ACCOUNT_ID`
- `CF_ZONE_ID`

#### "Workflow failed with exit code 1"

1. Check the Actions log for specific error
2. Try running locally first to debug
3. Use `--dry-run` to test without making changes

---

### Local Development

#### "Command not found: wrangler"

```bash
# Install wrangler globally
npm install -g wrangler

# Or use npx/pnpm exec
pnpm exec wrangler --version
```

#### "pnpm: command not found"

```bash
npm install -g pnpm
```

---

## Getting More Help

### Enable Verbose Logging

```bash
pnpm deploy:setup --verbose
```

### Collect Debug Information

When reporting issues, include:

```bash
# System info
node --version
pnpm --version
npx wrangler --version

# Cloudflare info
curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer $CF_API_TOKEN"

# Deployment state
cat .wrangler/state/deployment-*.json

# Environment (without secrets)
env | grep -E "^(CF_|BASE_|DEPLOY_)" | sed 's/TOKEN=.*/TOKEN=***/'
```

### Report Issues

File issues at: [GitHub Issues](https://github.com/YOUR_ORG/simple-agent-manager/issues)

Include:
1. Error message/code
2. Steps to reproduce
3. Debug information above
4. Environment (GitHub Actions, local, etc.)

---

*Last updated: January 2026*
