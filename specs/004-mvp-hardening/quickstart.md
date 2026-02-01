# Quickstart: MVP Hardening Development

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Date**: 2026-01-27

## Prerequisites

- Node.js 20+
- pnpm 8+
- Go 1.22+ (for VM Agent changes)
- Cloudflare account with Workers, KV, D1 access
- Wrangler CLI installed (`pnpm add -g wrangler`)

## Quick Setup

```bash
# Clone and install
git clone <repo-url>
cd simple-agent-manager
pnpm install

# Checkout feature branch
git checkout 004-mvp-hardening

# Set up local environment
cp .env.example .env.local
# Edit .env.local with your Cloudflare credentials
```

## Development Workflow

### 1. Run Development Servers

```bash
# Start all services (API + Web UI)
pnpm dev

# Or run individually:
pnpm --filter api dev      # API on http://localhost:8787
pnpm --filter web dev      # Web UI on http://localhost:5173
```

### 2. Database Migrations

```bash
# Apply new columns to D1
pnpm --filter api db:migrate

# Or manually via wrangler:
wrangler d1 execute simple-agent-manager --local --command \
  "ALTER TABLE workspaces ADD COLUMN error_reason TEXT;"
wrangler d1 execute simple-agent-manager --local --command \
  "ALTER TABLE workspaces ADD COLUMN shutdown_deadline TEXT;"
```

### 3. Create Shared Terminal Package

```bash
# Create package structure
mkdir -p packages/terminal/src
cd packages/terminal

# Initialize package
pnpm init

# Install dependencies
pnpm add @xterm/xterm @xterm/addon-fit @xterm/addon-attach
pnpm add -D typescript @types/react react react-dom
```

### 4. Build VM Agent

```bash
cd packages/vm-agent

# Build UI first
cd ui && pnpm install && pnpm build && cd ..

# Build Go binary
go build -o bin/vm-agent .

# Cross-compile for Linux
GOOS=linux GOARCH=amd64 go build -o bin/vm-agent-linux-amd64 .
```

## Key Files to Modify

### API (apps/api/)

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `errorReason`, `shutdownDeadline` columns |
| `src/routes/workspaces.ts` | Add ownership validation middleware |
| `src/routes/bootstrap.ts` | NEW: Bootstrap token redemption endpoint |
| `src/services/workspace.ts` | Generate bootstrap tokens, handle timeout |
| `src/index.ts` | Add cron trigger for timeout checking |
| `wrangler.toml` | Add cron trigger configuration |

### VM Agent (packages/vm-agent/)

| File | Change |
|------|--------|
| `internal/idle/detector.go` | Change to deadline-based tracking |
| `internal/server/routes.go` | Update heartbeat to send deadline |
| `main.go` | Add bootstrap token redemption on startup |

### Shared Terminal (packages/terminal/) - NEW

| File | Purpose |
|------|---------|
| `src/Terminal.tsx` | Main terminal component |
| `src/StatusBar.tsx` | Connection state + shutdown deadline |
| `src/useWebSocket.ts` | Reconnecting WebSocket hook |
| `src/useIdleDeadline.ts` | Deadline tracking and display |

### Web UI (apps/web/)

| File | Change |
|------|--------|
| `src/pages/Workspace.tsx` | Use shared terminal component |
| `package.json` | Add `@repo/terminal` dependency |

## Testing

### Unit Tests

```bash
# Run all tests
pnpm test

# Run specific package tests
pnpm --filter api test
pnpm --filter terminal test

# Watch mode
pnpm --filter api test:watch
```

### Integration Tests

```bash
# Test bootstrap token flow
curl -X POST http://localhost:8787/api/bootstrap/test-token

# Test ownership validation (should return 404)
curl -H "Authorization: Bearer <user-b-token>" \
  http://localhost:8787/api/workspaces/<user-a-workspace-id>
```

### E2E Tests

```bash
# Run with Playwright
pnpm --filter web test:e2e
```

## Common Tasks

### Add Ownership Validation to a Route

```typescript
// Before
app.get('/api/workspaces/:id', authMiddleware, async (c) => {
  const workspace = await getWorkspace(c.req.param('id'));
  return c.json(workspace);
});

// After
app.get('/api/workspaces/:id', authMiddleware, async (c) => {
  const workspace = await requireWorkspaceOwnership(c, c.req.param('id'));
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }
  return c.json(workspace);
});
```

### Test WebSocket Reconnection

1. Open terminal in browser
2. Open DevTools Network tab
3. Find WebSocket connection, right-click → "Close connection"
4. Observe "Reconnecting..." status
5. Verify reconnection within 5 seconds

### Test Provisioning Timeout

```bash
# Create workspace that won't complete
# (e.g., with invalid repo URL)
curl -X POST http://localhost:8787/api/workspaces \
  -H "Authorization: Bearer <token>" \
  -d '{"repository": "invalid/nonexistent", "branch": "main"}'

# Wait 10+ minutes (or reduce timeout for testing)
# Check workspace status changed to 'error'
```

## Deployment

```bash
# Deploy to staging
pnpm deploy:staging

# Run migrations in staging
wrangler d1 execute simple-agent-manager --env staging --command \
  "ALTER TABLE workspaces ADD COLUMN error_reason TEXT;"

# Deploy to production (after staging verification)
pnpm deploy
```

## Troubleshooting

### Bootstrap Token Not Working

1. Check KV binding in `wrangler.toml`
2. Verify token format (should be UUID)
3. Check token hasn't expired (5 min TTL)
4. Check token hasn't been redeemed already

### Cron Not Running

1. Verify cron trigger in `wrangler.toml`:
   ```toml
   [triggers]
   crons = ["*/5 * * * *"]
   ```
2. Check Worker logs: `wrangler tail`
3. Cron only runs in deployed Workers, not `wrangler dev`

### Terminal Not Reconnecting

1. Check browser console for WebSocket errors
2. Verify workspace is still running
3. Check network connectivity
4. Look for "Reconnecting..." overlay
