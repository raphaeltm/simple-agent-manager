# Architecture & Business Logic

## Stateless Design

The MVP uses a stateless architecture where workspace state is derived from:
1. **Hetzner server labels** — Metadata stored with VM
2. **Cloudflare DNS records** — Existence implies active workspace

No database is required for the MVP.

## Package Dependencies

```
@simple-agent-manager/shared
    ^
@simple-agent-manager/providers
    ^
@simple-agent-manager/api
    ^
@simple-agent-manager/web
```

Build order matters: shared -> providers -> api/web

### Adding New Features
1. Check if types need to be added to `packages/shared`
2. If provider-related, add to `packages/providers`
3. API endpoints go in `apps/api/src/routes/`
4. UI components go in `apps/web/src/components/`

## Architecture Research Requirements

Before making ANY changes related to architecture, secrets, credentials, data models, or security:

1. Research relevant architecture documentation:
   - `docs/architecture/` — Core architecture decisions
   - `docs/adr/` — Architecture Decision Records
   - `specs/` — Feature specifications with data models
   - `.specify/memory/constitution.md` — Project principles (especially Principle XI)

2. Use sequential thinking to:
   - Understand the existing architecture
   - Identify how your change fits (or conflicts)
   - Consider security implications
   - Validate against constitution principles
   - Document your reasoning

3. Provide explicit justification for any architecture-related changes

### Key Architecture Documents

| Document | Contents |
|----------|----------|
| `docs/architecture/credential-security.md` | BYOC model, encryption, user credentials |
| `docs/architecture/secrets-taxonomy.md` | Platform secrets vs user credentials |
| `docs/adr/002-stateless-architecture.md` | Stateless design principles |
| `.specify/memory/constitution.md` | Core principles and rules |

### Architecture Principles (Quick Reference)

1. **Bring-Your-Own-Cloud (BYOC)**: Users provide their own Hetzner tokens. The platform does NOT have cloud provider credentials.
2. **User credentials are encrypted per-user** in the database, NOT stored as environment variables or Worker secrets.
3. **Platform secrets** (ENCRYPTION_KEY, JWT keys, CF_API_TOKEN) are Cloudflare Worker secrets set during deployment.
4. **Observability First**: Every system must be designed with monitoring and visibility as a top priority, not an afterthought. If a process is running (builds, bootstraps, provisioning), the user and operators MUST be able to observe its progress in real time. Design data flows and server startup sequences so that monitoring endpoints (health checks, log streams, metrics) are available from the earliest possible moment — before the primary workload begins, not after it completes.

## Business Logic Research Requirements

Before making ANY changes related to features, workflows, state machines, validation rules, or user-facing behavior:

1. Research relevant feature specifications:
   - `specs/` — Feature specs with user stories, requirements, acceptance criteria
   - `specs/*/data-model.md` — State machines, entity relationships, constraints
   - `apps/api/src/db/schema.ts` — Current database schema and constraints
   - `apps/api/src/routes/` — Existing API behavior and validation

2. Use sequential thinking to:
   - Understand existing business rules and why they exist
   - Identify edge cases and error scenarios
   - Consider impact on existing features
   - Document your reasoning

### Key Business Logic Documents

| Document | Contents |
|----------|----------|
| `specs/003-browser-terminal-saas/spec.md` | Core SaaS features, user stories |
| `specs/003-browser-terminal-saas/data-model.md` | Entity relationships, state machines |
| `specs/004-mvp-hardening/spec.md` | Security hardening, access control |
| `specs/004-mvp-hardening/data-model.md` | Bootstrap tokens, ownership validation |

### Business Logic Principles (Quick Reference)

1. **Workspace Lifecycle**: pending -> creating -> running -> stopping -> stopped (see data-model.md)
2. **Idle Detection**: Configurable timeout (default 30 minutes via `IDLE_TIMEOUT_SECONDS`), managed by VM Agent with PTY activity detection
3. **Ownership Validation**: All workspace operations MUST verify `user_id` matches authenticated user
4. **Bootstrap Tokens**: One-time use, 5-minute expiry, cryptographically random
