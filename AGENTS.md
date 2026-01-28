# Agent Instructions

This document provides detailed instructions for AI coding agents working on this project.

## Architecture Overview

### Stateless Design

The MVP uses a stateless architecture where workspace state is derived from:
1. **Hetzner server labels** - Metadata stored with VM
2. **Cloudflare DNS records** - Existence implies active workspace

No database is required for the MVP.

### Package Dependencies

```
@simple-agent-manager/shared
    ↑
@simple-agent-manager/providers
    ↑
@simple-agent-manager/api
    ↑
@simple-agent-manager/web
```

Build order matters: shared → providers → api/web

## Development Guidelines

### Adding New Features

1. Check if types need to be added to `packages/shared`
2. If provider-related, add to `packages/providers`
3. API endpoints go in `apps/api/src/routes/`
4. UI components go in `apps/web/src/components/`

### Writing Tests

- Unit tests: `tests/unit/` in each package
- Integration tests: `apps/api/tests/integration/`
- Use Miniflare for Worker integration tests
- Critical paths require >90% coverage

### Error Handling

All API errors should follow this format:
```typescript
{
  error: "error_code",
  message: "Human-readable description"
}
```

### Environment Variables

Workers secrets are set via:
```bash
wrangler secret put SECRET_NAME
```

Local development uses `.dev.vars`:
```
CF_API_TOKEN=...
HETZNER_TOKEN=...
```

## Code Patterns

### Provider Implementation

```typescript
import { Provider, VMConfig, VMInstance } from './types';

export class MyProvider implements Provider {
  async createVM(config: VMConfig): Promise<VMInstance> {
    // Implementation
  }
}
```

### Hono Route Handler

```typescript
import { Hono } from 'hono';

const app = new Hono();

app.post('/endpoint', async (c) => {
  const body = await c.req.json();
  // Validate and process
  return c.json({ result: 'success' }, 201);
});
```

### React Component

```typescript
import { FC } from 'react';

interface Props {
  workspace: Workspace;
}

export const WorkspaceCard: FC<Props> = ({ workspace }) => {
  return (
    <div className="workspace-card">
      {/* Implementation */}
    </div>
  );
};
```

## Common Tasks

### Adding a New API Endpoint

1. Create route handler in `apps/api/src/routes/`
2. Register in `apps/api/src/index.ts`
3. Add integration tests
4. Update API contract in `specs/001-mvp/contracts/api.md`

### Adding a New Provider

1. Create provider class in `packages/providers/src/`
2. Implement `Provider` interface
3. Export from `packages/providers/src/index.ts`
4. Add unit tests

### Modifying Cloud-Init

1. Edit `scripts/vm/cloud-init.yaml`
2. Test locally with a VM if possible
3. Update `apps/api/src/services/cloud-init.ts` generator

## Troubleshooting

### Build Errors

Run builds in dependency order:
```bash
pnpm --filter @simple-agent-manager/shared build
pnpm --filter @simple-agent-manager/providers build
pnpm --filter @simple-agent-manager/api build
```

### Test Failures

Check if Miniflare bindings are configured in `vitest.config.ts`.

### Type Errors

Run `pnpm typecheck` from root to see all issues.
