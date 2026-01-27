# ADR 001: Monorepo Structure

**Status**: Accepted
**Date**: 2026-01-24
**Deciders**: Development Team

## Context

We need to organize the Cloud AI Workspaces codebase for:
- Multiple deployable applications (API, Web UI)
- Shared code between applications
- Independent package versioning
- Efficient CI/CD pipelines

## Decision

We will use a **monorepo structure** with pnpm workspaces and Turborepo:

```
cloud-ai-workspaces/
├── apps/
│   ├── api/          # Cloudflare Workers API
│   └── web/          # React web UI
├── packages/
│   ├── shared/       # Types, validation, utilities
│   └── providers/    # Cloud provider implementations
├── scripts/
│   └── vm/           # VM setup scripts
└── docs/             # Documentation
```

### Package Dependencies

```
@cloud-ai-workspaces/shared
    ↑
@cloud-ai-workspaces/providers
    ↑
@cloud-ai-workspaces/api
    ↑
@cloud-ai-workspaces/web
```

### Tool Choices

- **pnpm**: Fast, disk-efficient package manager with native workspace support
- **Turborepo**: Build orchestration with caching and parallel execution
- **TypeScript**: Type safety across all packages
- **Vitest**: Fast testing with native ESM support

## Consequences

### Positive

- Single source of truth for all code
- Easy sharing of types and utilities
- Atomic commits across packages
- Consistent tooling and configuration
- Fast local development with linked packages

### Negative

- Larger repository size
- Build complexity for interdependent packages
- Requires understanding of workspace tooling

### Neutral

- Requires building packages in dependency order
- CI/CD pipelines need turborepo integration

## Alternatives Considered

1. **Polyrepo**: Separate repositories per package
   - Rejected: Too much overhead for small team

2. **Single package**: All code in one npm package
   - Rejected: Poor separation of concerns

3. **Nx**: Alternative to Turborepo
   - Rejected: More complex, pnpm+turbo sufficient for our needs
