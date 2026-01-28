# Implementation Plan: MVP Hardening

**Branch**: `004-mvp-hardening` | **Date**: 2026-01-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-mvp-hardening/spec.md`

## Summary

Harden the MVP for production readiness by addressing security, reliability, and UX gaps:

1. **Secure Secret Handling**: Replace plaintext secrets in cloud-init with one-time bootstrap tokens stored in KV
2. **Workspace Access Control**: Add ownership validation middleware to all workspace endpoints
3. **Provisioning Timeout**: Implement cron-based timeout checking for stuck workspaces
4. **Terminal Reconnection**: Create shared terminal package with automatic WebSocket reconnection
5. **Idle Deadline Model**: Change from duration-based to deadline-based idle tracking
6. **Terminal Consolidation**: Extract shared terminal component used by web UI and VM agent UI

## Technical Context

**Language/Version**: TypeScript 5.x (API, Web, packages) + Go 1.22+ (VM Agent)
**Primary Dependencies**: Hono (API), React + Vite (Web), xterm.js (Terminal), Drizzle ORM (Database)
**Storage**: Cloudflare D1 (workspaces), Cloudflare KV (sessions, bootstrap tokens)
**Testing**: Vitest + Miniflare (unit/integration), Playwright (e2e)
**Target Platform**: Cloudflare Workers (API), Cloudflare Pages (Web), Hetzner VMs (Agent)
**Project Type**: Monorepo (pnpm workspaces + Turborepo)
**Performance Goals**: Terminal reconnection within 5 seconds of network restoration
**Constraints**: Bootstrap token window of 5 minutes, provisioning timeout of 10 minutes
**Scale/Scope**: Self-hosted deployments, 5 workspaces per user limit

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| **II. Infrastructure Stability** | ✅ PASS | TDD required for bootstrap, timeout, ownership (critical paths) |
| **IX. Clean Architecture** | ✅ PASS | New `packages/terminal` follows monorepo structure |
| **X. Simplicity & Clarity** | ✅ PASS | Using existing KV/cron patterns, no new abstractions |
| **VI. Automated Quality Gates** | ✅ PASS | CI will enforce test coverage |
| **VIII. AI-Friendly Repository** | ✅ PASS | Clear file naming, co-located logic |

**Post-Design Re-check**:
- ✅ No new packages beyond `packages/terminal` (justified by 2 consumers)
- ✅ No circular dependencies introduced
- ✅ Bootstrap token mechanism uses existing KV infrastructure
- ✅ Cron trigger is simpler than Durable Objects alternative

## Project Structure

### Documentation (this feature)

```text
specs/004-mvp-hardening/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Technical research and decisions
├── data-model.md        # Entity changes and migrations
├── quickstart.md        # Developer quickstart guide
├── contracts/
│   └── api.yaml         # OpenAPI contract for new/modified endpoints
└── tasks.md             # Implementation tasks (created by /speckit.tasks)
```

### Source Code (repository root)

```text
apps/
├── api/
│   ├── src/
│   │   ├── db/
│   │   │   └── schema.ts          # MODIFY: Add errorReason, shutdownDeadline
│   │   ├── routes/
│   │   │   ├── workspaces.ts      # MODIFY: Add ownership validation
│   │   │   └── bootstrap.ts       # NEW: Bootstrap token redemption
│   │   ├── middleware/
│   │   │   └── workspace-auth.ts  # NEW: Ownership validation helper
│   │   ├── services/
│   │   │   └── workspace.ts       # MODIFY: Bootstrap token generation
│   │   └── index.ts               # MODIFY: Add cron trigger
│   ├── tests/
│   │   ├── unit/
│   │   │   ├── bootstrap.test.ts  # NEW
│   │   │   └── ownership.test.ts  # NEW
│   │   └── integration/
│   │       └── timeout.test.ts    # NEW
│   └── wrangler.toml              # MODIFY: Add cron trigger
│
└── web/
    ├── src/
    │   └── pages/
    │       └── Workspace.tsx      # MODIFY: Use shared terminal

packages/
├── terminal/                      # NEW PACKAGE
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts               # Public exports
│   │   ├── Terminal.tsx           # Main terminal component
│   │   ├── StatusBar.tsx          # Connection state + deadline
│   │   ├── ConnectionOverlay.tsx  # Reconnecting/failed overlay
│   │   ├── useWebSocket.ts        # Reconnection hook
│   │   ├── useIdleDeadline.ts     # Deadline tracking
│   │   └── types.ts               # Shared types
│   └── tests/
│       └── useWebSocket.test.ts
│
├── vm-agent/
│   ├── internal/
│   │   ├── idle/
│   │   │   └── detector.go        # MODIFY: Deadline-based tracking
│   │   └── server/
│   │       └── routes.go          # MODIFY: Heartbeat with deadline
│   ├── main.go                    # MODIFY: Bootstrap on startup
│   └── ui/
│       └── src/
│           └── App.tsx            # MODIFY: Use shared terminal
│
├── cloud-init/
│   └── src/
│       └── template.ts            # MODIFY: Remove secrets, add bootstrap
│
└── shared/
    └── src/
        └── types.ts               # MODIFY: Add new response types
```

**Structure Decision**: Existing monorepo structure with new `packages/terminal` package. This follows Constitution Principle IX (shared code extracted when used by 2+ consumers: web UI and VM agent UI).

## Key Implementation Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Provisioning timeout | Cloudflare Cron Triggers | Simpler than Durable Objects; runs every 5 minutes to stay within free tier |
| Bootstrap token storage | Cloudflare KV with TTL | Auto-expiry, simple get/delete for single-use |
| WebSocket reconnection | Custom hook | No suitable library; straightforward implementation |
| Ownership validation | Middleware returning 404 | Prevents information disclosure |
| Idle tracking | Absolute deadline timestamp | Clearer UX, simpler comparison logic |

## Complexity Tracking

> No Constitution violations requiring justification.

| Decision | Why It's Simple |
|----------|-----------------|
| Single new package (terminal) | Has 2 consumers; follows Constitution guideline |
| KV for bootstrap tokens | Uses existing infrastructure; no new services |
| Cron for timeout | Native Workers feature; no external dependencies |

## Related Documents

- [Research](./research.md) - Technical decisions and alternatives
- [Data Model](./data-model.md) - Entity changes and migrations
- [API Contract](./contracts/api.yaml) - OpenAPI specification
- [Quickstart](./quickstart.md) - Developer setup guide
