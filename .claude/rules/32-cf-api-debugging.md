# Cloudflare API Debugging (Use This Before Guessing)

## You Have Direct Access to Staging Infrastructure

The `CF_TOKEN` environment variable contains a Cloudflare API token scoped to the SAM staging account. **Use it.** Before navigating the admin UI, before deploying just to check if something worked, before guessing — query the infrastructure directly.

This is the fastest way to debug staging issues. A `curl` call takes seconds. A deploy cycle takes 7 minutes. Use the API first.

## Account & Resource IDs

| Resource | ID |
|----------|-----|
| **Account** | `c4e4aebd980b626f6af43ac6b1edcede` |
| **D1 (sam-staging)** | `1cfaf5d4-8226-47d8-bf26-6ba727ce5718` |
| **D1 (sam-observability-staging)** | `8c2fa46c-3b89-428b-b235-d835b7914106` |
| **KV (sam-staging-sessions)** | `cbeb633bc3794dd88a0b488d46a1922d` |
| **Zone (sammy.party)** | `ff189eb6d934a6c2b3f9f9595cafc256` |
| **Worker** | `sam-api-staging` |
| **Tail Worker** | `sam-tail-worker-staging` |
| **R2 Bucket** | `sam-staging-assets` |

## Token Capabilities

| Resource | Read | Write | Delete |
|----------|------|-------|--------|
| **D1** | Query (SQL) | -- | -- |
| **KV** | List + Read | Write | Delete |
| **Workers** | List + Tail | -- | -- |
| **R2** | List | -- | -- |
| **DNS** | Read | -- | -- |
| **Zones** | Read | -- | -- |

## Quick Reference: Common Debugging Queries

All commands use `$CF_TOKEN` from the environment. Copy-paste ready.

### Query D1 (Most Useful)

```bash
# Row counts for key tables
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT (SELECT count(*) FROM users) as users, (SELECT count(*) FROM projects) as projects, (SELECT count(*) FROM tasks) as tasks, (SELECT count(*) FROM nodes) as nodes, (SELECT count(*) FROM workspaces) as workspaces"}' \
  "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/d1/database/1cfaf5d4-8226-47d8-bf26-6ba727ce5718/query"

# Check a specific table's schema
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql": "PRAGMA table_info(projects)"}' \
  "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/d1/database/1cfaf5d4-8226-47d8-bf26-6ba727ce5718/query"

# Check migration status
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM d1_migrations ORDER BY id DESC LIMIT 5"}' \
  "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/d1/database/1cfaf5d4-8226-47d8-bf26-6ba727ce5718/query"

# Run any read-only query (replace SQL as needed)
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT id, name, status FROM nodes WHERE status != '\''destroyed'\'' LIMIT 20"}' \
  "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/d1/database/1cfaf5d4-8226-47d8-bf26-6ba727ce5718/query"
```

### Read and Write KV

```bash
# List all keys
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/storage/kv/namespaces/cbeb633bc3794dd88a0b488d46a1922d/keys?limit=100"

# Read a specific key
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/storage/kv/namespaces/cbeb633bc3794dd88a0b488d46a1922d/values/<key-name>"

# Write a KV value (e.g., flip a feature flag)
curl -s -X PUT \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: text/plain" \
  -d "true" \
  "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/storage/kv/namespaces/cbeb633bc3794dd88a0b488d46a1922d/values/<key-name>"

# Delete a KV key (e.g., clear a rate limit entry)
curl -s -X DELETE \
  -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/storage/kv/namespaces/cbeb633bc3794dd88a0b488d46a1922d/values/<key-name>"
```

### Check DNS Records

```bash
# List DNS records (useful for debugging workspace routing)
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/ff189eb6d934a6c2b3f9f9595cafc256/dns_records?per_page=50"
```

### List R2 Bucket Contents

```bash
# Check what's in the assets bucket (VM agent binaries, attachments)
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/r2/buckets/sam-staging-assets/objects"
```

### Check Worker Details

```bash
# List deployed workers and their config
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/workers/scripts"
```

## When to Use CF API vs Other Tools

| Scenario | Use CF API | Not This |
|----------|-----------|----------|
| **Check if migration ran** | Query `d1_migrations` table | Deploy again and hope |
| **Verify data after deploy** | Query D1 tables directly | Navigate admin UI via Playwright |
| **Check feature flag state** | Read KV key | Look at the code and guess |
| **Debug workspace routing** | Read DNS records | SSH into VMs |
| **Verify binary upload** | List R2 objects | Re-run the deploy |
| **Check rate limit state** | Read/delete KV rate limit keys | Wait for the window to expire |
| **Flip a feature flag for testing** | Write KV value | Redeploy with different config |

## Integration with Development Loop

The recommended staging debugging flow is:

1. **Deploy to staging** via `gh workflow run deploy-staging.yml --ref <branch>` (~7 min)
2. **While waiting for deploy**: verify your assumptions using CF API queries (D1 state, KV flags, DNS records)
3. **After deploy lands**: query D1 to confirm migrations ran and data looks right
4. **Test the feature** via Playwright against `app.sammy.party`
5. **If something is wrong**: query D1/KV/DNS to understand the state BEFORE changing code
6. **Fix, push, redeploy** — but only after you understand what's actually broken

## IMPORTANT: Do Not Bypass the Deploy Pipeline

The CF token gives you **read access** to most resources and **write access** to KV. This is for debugging and observation.

**You MUST NOT:**
- Deploy Workers directly via the API (always use `gh workflow run`)
- Modify D1 data (the token is read-only for D1 anyway)
- Create or delete infrastructure resources

Staging must replicate the exact production deploy pipeline. Direct API access is for **observing and understanding**, not for making changes that bypass GitHub Actions.

The one exception is **KV writes for debugging** — flipping feature flags, clearing rate limit entries, or setting test values. These are ephemeral state changes that the next deploy would overwrite anyway.
