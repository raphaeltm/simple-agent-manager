# Quickstart: Project-First Architecture

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Data Model**: [data-model.md](./data-model.md)

This guide covers how to develop and test the project-first architecture feature locally and on staging.

---

## Prerequisites

- Node.js 18+, pnpm 8+
- Cloudflare account with Workers Paid plan ($5/month minimum for Durable Objects)
- Existing SAM deployment (spec 016 projects/tasks foundation implemented)

## Local Development

### 1. Build in dependency order

```bash
pnpm install
pnpm --filter @simple-agent-manager/shared build
pnpm --filter @simple-agent-manager/providers build
```

### 2. Configure Durable Object bindings

The `wrangler.toml` changes add a new Durable Object namespace. For local dev with `wrangler dev`, Miniflare simulates DOs locally:

```toml
# Added to wrangler.toml
[[durable_objects.bindings]]
name = "PROJECT_DATA"
class_name = "ProjectData"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ProjectData"]
```

### 3. Run local dev

```bash
cd apps/api
pnpm dev  # wrangler dev — Miniflare handles D1, KV, DO locally
```

```bash
cd apps/web
pnpm dev  # Vite dev server
```

### 4. Test DO behavior locally

The Durable Object is exercised through API endpoints. Use curl or the web UI:

```bash
# Create a project (with github_repo_id)
curl -X POST http://localhost:8787/api/projects \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-project",
    "installationId": "inst-123",
    "repository": "user/repo",
    "githubRepoId": 515187740,
    "defaultBranch": "main"
  }'

# List chat sessions (proxied to DO)
curl http://localhost:8787/api/projects/{projectId}/sessions

# Get activity feed (proxied to DO)
curl http://localhost:8787/api/projects/{projectId}/activity
```

## Testing

### Unit Tests

```bash
# Run all tests
pnpm test

# Run DO-specific tests
pnpm --filter @simple-agent-manager/api test -- --grep "ProjectData"
```

### Key test files

| Test File | What It Tests |
|-----------|--------------|
| `apps/api/tests/unit/project-data-do.test.ts` | DO class: migrations, CRUD, message persistence |
| `apps/api/tests/unit/chat-persistence.test.ts` | Message pipeline: Worker → DO write path |
| `apps/api/tests/integration/project-data.test.ts` | Full flow: API → DO → response via Miniflare |

### Integration Tests with Miniflare

Miniflare v3 supports Durable Objects with SQLite. Integration tests use `unstable_dev()` or the Miniflare API:

```typescript
import { unstable_dev } from 'wrangler';

const worker = await unstable_dev('src/index.ts', {
  experimental: { disableExperimentalWarning: true },
});

// Worker is running with D1, KV, and DO support
const response = await worker.fetch('/api/projects/test-id/sessions');
```

## Staging Deployment

### 1. Push to branch

```bash
git push origin 018-project-first-architecture
```

### 2. Deploy to staging

The CI workflow deploys on push. For manual staging deploy:

```bash
cd apps/api
pnpm wrangler deploy --env staging
```

### 3. Verify DO creation

After creating a project and triggering a chat session on staging:

```bash
# Check DO storage via wrangler (staging)
pnpm wrangler d1 execute workspaces-staging --command "SELECT * FROM projects WHERE github_repo_id IS NOT NULL"
```

The DO itself is not directly queryable via wrangler — verify through API endpoints.

## Architecture Overview

```
┌────────────────────────────────────────────────┐
│                  API Worker                      │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │
│  │  Routes   │  │ Services  │  │  DO Stubs     │ │
│  │ (Hono)   │→│ (logic)   │→│ (RPC calls)   │ │
│  └──────────┘  └──────────┘  └──────┬───────┘ │
│                                      │          │
└──────────────────────────────────────┼──────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  ▼                   │
                    │         ┌───────────────┐           │
                    │         │  ProjectData   │           │
                    │         │  Durable Object │          │
                    │         │                 │          │
                    │         │  ┌───────────┐ │          │
                    │         │  │  SQLite    │ │          │
                    │         │  │  - sessions│ │          │
                    │  D1     │  │  - messages│ │          │
                    │ (central│  │  - events  │ │          │
                    │  meta)  │  └───────────┘ │          │
                    │         │                 │          │
                    │         │  WebSocket ←──────── Browser
                    │         └───────────────┘           │
                    └─────────────────────────────────────┘
```

## Key Files to Understand

| File | Purpose |
|------|---------|
| `apps/api/src/durable-objects/project-data.ts` | The per-project DO class with SQLite schema |
| `apps/api/src/durable-objects/migrations.ts` | DO schema migration definitions and runner |
| `apps/api/src/services/project-data.ts` | Service layer: Worker ↔ DO interaction |
| `apps/api/src/services/chat-persistence.ts` | Message persistence pipeline |
| `apps/api/src/routes/chat.ts` | Chat session/message API routes |
| `apps/api/src/routes/activity.ts` | Activity feed API routes |
| `apps/api/wrangler.toml` | DO binding configuration |

## Troubleshooting

| Issue | Solution |
|-------|---------|
| "Durable Object not found" | Ensure `wrangler.toml` has `[[durable_objects.bindings]]` and `[[migrations]]` configured |
| DO migrations not running | Check that `blockConcurrencyWhile()` is called in the constructor |
| WebSocket upgrade fails | Ensure the route handler returns `stub.fetch(c.req.raw)` for upgrade requests |
| D1 migration errors | Run `pnpm wrangler d1 migrations apply` for the target environment |
| Cross-project queries slow | Verify D1 `last_activity_at` index exists; check DO summary sync is working |
