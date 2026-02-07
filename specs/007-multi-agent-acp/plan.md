# Implementation Plan: Multi-Agent Support via ACP

**Branch**: `007-multi-agent-acp` | **Date**: 2026-02-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/007-multi-agent-acp/spec.md`

## Summary

Extend SAM to support multiple AI coding agents (Claude Code, OpenAI Codex, Google Gemini CLI) via the Agent Client Protocol (ACP). All agents are pre-installed in every workspace. Users select which agent to use at runtime from within a running workspace and can switch freely. The raw terminal is replaced with a structured conversation UI (tool cards, permission dialogs, file diffs, thinking indicators) while keeping the terminal available as a fallback.

The core technical change is adding an ACP WebSocket gateway to the Go VM Agent that bridges browser WebSocket connections to agent subprocess stdio (NDJSON), plus a new React component package for rendering structured ACP messages.

## Technical Context

**Language/Version**: TypeScript 5.x (API, Web, packages) + Go 1.22+ (VM Agent)
**Primary Dependencies**: Hono (API), React + Vite (Web), xterm.js (Terminal), @agentclientprotocol/sdk v0.14.x (ACP types), gorilla/websocket + creack/pty (VM Agent)
**Storage**: Cloudflare D1 (workspaces, credentials) + KV (sessions, tokens) + R2 (binaries)
**Testing**: Vitest + Miniflare (TS), Go testing (VM Agent)
**Target Platform**: Cloudflare Workers (API), Cloudflare Pages (Web), Linux VMs with Docker (VM Agent)
**Project Type**: Monorepo (pnpm workspaces + Turborepo)
**Performance Goals**: Agent session start <10s (SC-001), ACP view interactive <5s (SC-003), fallback <5s (SC-005)
**Constraints**: ACP protocol pre-1.0, WebSocket transport not standardized (bridge required), Claude Code and Codex need ACP adapters (not native)
**Scale/Scope**: 3 agents at launch, one active session per workspace, user-global API keys

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| **I. Open Source** | PASS | ACP is Apache 2.0, SDK is open source, no proprietary lock-in |
| **II. Infrastructure Stability** | PASS | TDD required for: ACP gateway, agent lifecycle, credential encryption, WebSocket bridge. 90%+ coverage on critical paths. |
| **III. Documentation Excellence** | PASS | ADR for ACP adoption, API docs for new endpoints, guide for agent key setup |
| **IV. Approachable Code** | PASS | Actionable errors ("API key not configured for Gemini — add it in Settings"), loading states for ACP init, immediate feedback on agent switch |
| **VI. Automated Quality Gates** | PASS | CI covers new packages, Vitest for acp-client, Go tests for gateway |
| **VIII. AI-Friendly Repo** | PASS | CLAUDE.md updated with agent endpoints, agent registry types self-documenting |
| **IX. Clean Code Architecture** | PASS | New `packages/acp-client` follows packages → apps dependency flow. No circular deps. |
| **X. Simplicity & Official SDKs** | PASS | Uses `@agentclientprotocol/sdk` official types. Custom WebSocket transport is minimal (SDK provides stdio only). |
| **XI. No Hardcoded Values** | PASS | Agent init timeout: `ACP_INIT_TIMEOUT_MS` env var. Agent commands/args: configurable via agent registry. Reconnect delay: `ACP_RECONNECT_DELAY_MS` env var. All URLs derived from `BASE_DOMAIN`. |

**No violations.** All principles satisfied without justification needed.

## Project Structure

### Documentation (this feature)

```text
specs/007-multi-agent-acp/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (OpenAPI)
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
packages/
├── acp-client/                    # NEW: React ACP client components
│   ├── src/
│   │   ├── components/
│   │   │   ├── AgentPanel.tsx      # Main panel (message list + prompt input)
│   │   │   ├── MessageBubble.tsx   # Agent/user message with markdown
│   │   │   ├── ToolCallCard.tsx    # Tool execution card with status
│   │   │   ├── PermissionDialog.tsx # Approve/reject tool permission
│   │   │   ├── ThinkingBlock.tsx   # Collapsible reasoning display
│   │   │   ├── FileDiffView.tsx    # Side-by-side or unified diff
│   │   │   ├── TerminalBlock.tsx   # Embedded command output
│   │   │   ├── UsageIndicator.tsx  # Token usage display
│   │   │   └── ModeSelector.tsx    # Agent mode switcher
│   │   ├── hooks/
│   │   │   ├── useAcpSession.ts    # Session lifecycle (init, prompt, cancel)
│   │   │   └── useAcpMessages.ts   # Streaming message state management
│   │   ├── transport/
│   │   │   ├── websocket.ts        # WebSocket ↔ ACP JSON-RPC bridge
│   │   │   └── types.ts            # ACP message type definitions
│   │   └── index.ts
│   ├── package.json
│   └── tsconfig.json
│
├── vm-agent/
│   └── internal/
│       └── acp/                    # NEW: ACP gateway module
│           ├── gateway.go          # WebSocket ↔ stdio bridge
│           ├── process.go          # Agent subprocess lifecycle
│           ├── transport.go        # Per-agent transport handlers
│           └── gateway_test.go     # Integration tests
│
├── shared/
│   └── src/
│       └── agents.ts               # NEW: Agent registry types + definitions
│
├── terminal/                       # EXISTING: unchanged (PTY fallback)
├── cloud-init/                     # MODIFIED: install all agents in devcontainer
└── providers/                      # EXISTING: unchanged

apps/
├── api/
│   └── src/
│       ├── routes/
│       │   ├── credentials.ts      # MODIFIED: support agent-api-key credential type
│       │   └── agents.ts           # NEW: agent catalog endpoint
│       └── db/
│           └── schema.ts           # MODIFIED: credentials table agent fields
│
└── web/
    └── src/
        ├── pages/
        │   ├── Workspace.tsx       # MODIFIED: dual-mode ACP/PTY with agent selector
        │   └── Settings.tsx        # MODIFIED: agent API key management section
        └── components/
            └── AgentSelector.tsx   # NEW: agent picker component
```

**Structure Decision**: Follows existing monorepo conventions. New `packages/acp-client` is a shared library consumed by `apps/web`. Go ACP module is co-located with VM Agent internals. Agent registry types live in `packages/shared` for cross-package use.

## Complexity Tracking

No violations to justify. All changes fit within existing architecture patterns.
