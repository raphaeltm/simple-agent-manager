# Content Ideas

A living pipeline of content topics with enough context to pick up and draft. Each idea captures the angle, why it's externally interesting, and key code references so the research doesn't need to be repeated.

**Last Updated**: 2026-03-15
**Update Trigger**: New feature shipped, architecture change merged, or competitive landscape shift

## How to Use This File

1. **Add ideas** as they emerge — during feature work, post-mortems, or research
2. **Promote to draft** by creating a file in `strategy/content/drafts/` and linking it here
3. **Remove or archive** ideas that are no longer relevant
4. **Check messaging guide** (`strategy/marketing/messaging-guide.md`) before drafting

## Status Legend

- **New** — idea captured, not yet prioritized
- **Prioritized** — worth writing soon
- **In Draft** — draft exists in `strategy/content/drafts/`
- **Published** — live, link included

---

## Ideas

### Multi-Agent Architecture: One Platform, Any AI

**Status**: New
**Priority**: High
**Type**: Blog post / technical deep-dive
**Audience**: Developers evaluating AI coding platforms

**Angle**: Most platforms lock you to a single AI provider. SAM lets users choose their agent at runtime — Claude Code, Mistral Vibe, OpenAI Codex, Google Gemini — with unified session lifecycle, credential injection, and context sharing across all of them.

**Why it's interesting externally**:
- Direct competitive differentiator — no other platform offers runtime agent selection
- Addresses vendor lock-in concerns (hot topic in AI tooling)
- Shows a clean abstraction pattern other projects could learn from

**Key code references**:
- Agent abstraction: `packages/vm-agent/internal/acp/gateway.go` — `AgentCommandInfo` struct, `getAgentCommandInfo()`
- Dynamic config generation: `packages/vm-agent/internal/acp/session_host.go` — `generateVibeConfig()`
- Agent installation: `packages/vm-agent/internal/acp/session_host.go` — `ensureAgentInstalled()` with mutex serialization
- Credential injection modes: env-based (Claude) vs auth-file (Codex) vs config-file (Vibe)

**Messaging hooks**: Infrastructure freedom, agent-agnostic, no vendor lock-in

---

### Server-Side TTS on the Edge: Composing Workers AI + R2

**Status**: New
**Priority**: High
**Type**: Blog post / tutorial
**Audience**: Cloudflare developers, serverless practitioners

**Angle**: How we built a text-to-speech feature using three Cloudflare primitives (Workers AI + R2 + Workers) with zero external APIs. Includes an LLM-for-preprocessing pattern where Gemma cleans markdown into natural speech text before Deepgram generates audio.

**Why it's interesting externally**:
- Practical example of composing Workers AI with other Cloudflare services
- The LLM-as-preprocessor pattern is novel and reusable
- Shows graceful degradation (LLM cleanup -> regex fallback, server TTS -> browser fallback)
- Deterministic R2 caching without a database is an elegant pattern

**Key code references**:
- Service layer: `apps/api/src/services/tts.ts` — full pipeline (cleanup -> generate -> cache)
- LLM cleanup prompt: `apps/api/src/services/tts.ts` — `CLEANUP_INSTRUCTIONS`
- R2 key structure: `tts/{userId}/{storageId}.{encoding}` — user-scoped, deterministic
- Route handlers: `apps/api/src/routes/tts.ts` — synthesize + serve endpoints
- Frontend integration: `packages/acp-client/src/components/MessageActions.tsx` — two-tier fallback

**Messaging hooks**: Edge-native AI, zero external dependencies, serverless composition

---

### Zero-Knowledge Cloud Infrastructure (BYOC)

**Status**: In Draft
**Priority**: High
**Type**: Blog post
**Audience**: Security-conscious developers, enterprise evaluators
**Draft**: `strategy/content/drafts/2026-03-11-blog-outline-byoc.md`

**Angle**: SAM never holds your cloud credentials. Users bring their own Hetzner/Scaleway tokens, encrypted per-user with AES-GCM and unique IVs. A platform compromise doesn't expose user infrastructure.

**Why it's interesting externally**:
- Directly addresses enterprise compliance and trust concerns
- Contrasts with managed platforms (Heroku, Replit) that hold master credentials
- The encryption pattern (unique IV per credential, cascade delete) is a good security teaching example

**Key code references**:
- Credential encryption: `apps/api/src/services/encryption.ts`
- BYOC architecture: `docs/architecture/credential-security.md`
- Multi-provider credentials: `apps/api/src/services/provider-credentials.ts` — `serializeCredentialToken()`
- Provider factory: `packages/providers/src/index.ts` — `createProvider()`

---

### Conversation Forking: Solving Context Loss Across Agent Sessions

**Status**: New
**Priority**: Medium-High
**Type**: Blog post / product story
**Audience**: AI tooling developers, product builders

**Angle**: When an agent session ends, the context dies with it. SAM's conversation forking lets users continue from any completed session with an AI-generated summary of what happened — editable by the human before the new agent picks up.

**Why it's interesting externally**:
- Real UX problem that every AI coding tool faces
- Three-tier summarization fallback (verbatim -> AI -> heuristic) is production-quality thinking
- Smart chunking (first 5 + last 20 messages) preserves narrative without overwhelming the new agent
- Human-in-the-loop summary editing is a novel pattern
- Branch inheritance enables multi-session feature chains

**Key code references**:
- Summarization service: `apps/api/src/services/session-summarize.ts` — filtering, chunking, AI, fallback
- Chunking strategy: first 5 messages (original intent) + last N messages (current state)
- Fork dialog: `apps/web/src/components/project/ForkDialog.tsx` — editable summary textarea
- Task submission with lineage: `apps/api/src/routes/tasks/submit.ts` — `parentTaskId` + `contextSummary`
- Spec: `specs/029-conversation-forking/spec.md`

**Messaging hooks**: Iterative agent work, context preservation, human-AI collaboration

---

### Agent Self-Service Context via MCP

**Status**: New
**Priority**: Medium-High
**Type**: Blog post / technical deep-dive
**Audience**: MCP ecosystem developers, AI agent builders

**Angle**: Instead of bloating agent prompts with all project context upfront, SAM exposes 6 read-only MCP tools that let agents query what they need — tasks, sessions, message history, full-text search. Agents discover their own context on demand.

**Why it's interesting externally**:
- Shifts from "push all context" to "agents pull what they need" — reduces token consumption
- Project-scoped security via task-scoped tokens prevents cross-project leakage
- Snippet extraction pattern (200-char windows around search matches) is reusable
- Enables emergent multi-agent coordination without explicit messaging

**Key code references**:
- MCP tool definitions: `apps/api/src/routes/mcp.ts` — 6 tool handlers
- Token auth: `apps/api/src/routes/mcp.ts` — `authenticateMcpRequest()` with KV-backed tokens
- Message search with snippets: `apps/api/src/durable-objects/project-data.ts` — `searchMessages()`
- Own-task exclusion: agents see other work by default

**Messaging hooks**: Agent-first design, MCP ecosystem, context-aware agents

---

### Warm Node Pooling: Three-Layer Defense Against Orphaned VMs

**Status**: New
**Priority**: Medium
**Type**: Blog post / infrastructure deep-dive
**Audience**: Cloud infrastructure engineers, serverless practitioners

**Angle**: After a task completes, SAM keeps the VM "warm" for 30 minutes for fast reuse. Three independent cleanup mechanisms ensure no VM is ever orphaned: DO alarm, cron sweep, and hard lifetime ceiling.

**Why it's interesting externally**:
- Defense-in-depth applied to infrastructure lifecycle (not just security)
- Durable Object alarms as free timeout infrastructure — no polling needed
- Race-safe claiming pattern for concurrent task submissions
- Configurable at every level (warm timeout, grace period, max lifetime)

**Key code references**:
- NodeLifecycle DO: `apps/api/src/durable-objects/node-lifecycle.ts` — state machine + alarm
- Cron sweep: `apps/api/src/scheduled/node-cleanup.ts` — Layer 2 cleanup
- Node selector: `apps/api/src/services/node-selector.ts` — warm node querying + `tryClaim()`
- Constants: `packages/shared/src/constants.ts` — all timeout defaults

**Messaging hooks**: Infrastructure reliability, cost control, Cloudflare DO patterns

---

### Streaming Token Ordering: An Elegant Go Concurrency Fix

**Status**: New
**Priority**: Medium
**Type**: Short blog / technical note
**Audience**: Go developers, real-time systems engineers

**Angle**: The ACP SDK dispatches notification handlers in concurrent goroutines, causing streaming tokens to arrive out of order. `orderedPipe` fixes this by wrapping stdout with a synchronous `io.Pipe` that gates delivery until the previous handler completes — no locks, no channels beyond a single signal channel.

**Why it's interesting externally**:
- Clean concurrency pattern using Go's `io.Pipe` synchronicity as the enforcement mechanism
- Non-invasive — wraps stdout without modifying the SDK
- Selective serialization (only `session/update` notifications, others pass through)
- Safety-net timeout prevents deadlock in edge cases

**Key code references**:
- Implementation: `packages/vm-agent/internal/acp/ordered_reader.go`
- Tests: `packages/vm-agent/internal/acp/ordered_reader_test.go`
- Integration: `packages/vm-agent/internal/acp/session_host.go` — `processedCh` signal flow
- Config: `ACP_NOTIF_SERIALIZE_TIMEOUT` (default 5s)

**Messaging hooks**: Go concurrency patterns, real-time streaming, elegant solutions

---

### Heartbeat-Based VM Failure Detection with DO Alarms

**Status**: New
**Priority**: Medium-Low
**Type**: Short blog / technical note
**Audience**: Cloudflare Workers developers, distributed systems engineers

**Angle**: SAM detects VM agent failures without polling. The ProjectData Durable Object schedules an alarm when a heartbeat arrives; if the next heartbeat doesn't arrive before the alarm fires, the session is automatically marked as failed. Cloudflare alarms provide free, reliable timeout infrastructure.

**Why it's interesting externally**:
- Replaces polling with event-driven failure detection
- Zero cost when healthy (alarms are rescheduled, never fire)
- Pattern is applicable to any system that needs liveness detection
- Combined with session ownership in DOs, makes the system resilient to VM crashes

**Key code references**:
- Session lifecycle: `apps/api/src/durable-objects/project-data.ts` — heartbeat handling + alarm scheduling
- Detection window: `ACP_SESSION_DETECTION_WINDOW_MS` (configurable)
- Spec: `specs/027-do-session-ownership/spec.md`

**Messaging hooks**: Durable Objects patterns, distributed systems, zero-polling architecture

---

### Secure CORS by Default: A Pattern for Workers APIs

**Status**: New
**Priority**: Medium-Low
**Type**: Short blog / security tutorial
**Audience**: Web security practitioners, Cloudflare Workers developers

**Angle**: CORS misconfiguration is one of the most common web vulnerabilities. SAM's approach — parse origins via `new URL()`, compare hostnames (not substrings), default to deny for unrecognized origins — is a good teaching example. Includes the pattern for token-auth endpoints that safely use `origin: '*'`.

**Why it's interesting externally**:
- CORS misconfiguration is extremely common (OWASP recurring issue)
- The default-deny + per-route override pattern is reusable
- Explains when `origin: '*'` is actually safe (Bearer auth, no cookies)
- Born from a real production bug (documented in post-mortem)

**Key code references**:
- Global CORS middleware: `apps/api/src/index.ts` — origin callback
- MCP override: `apps/api/src/index.ts` — `origin: '*'` with `credentials: false`
- Post-mortem: `docs/notes/2026-03-09-cors-origin-fallthrough-postmortem.md`

**Messaging hooks**: Web security, CORS best practices, defense-in-depth

---

### AI-Powered Task Titles: Lightweight LLM Integration in Workers

**Status**: New
**Priority**: Low
**Type**: Short blog / tutorial
**Audience**: Cloudflare Workers developers

**Angle**: Using Workers AI (Llama 3.1 8B) synchronously in an API request to generate concise task titles. Covers the retry strategy (don't retry timeouts, do retry rate limits), markdown post-processing, and the synchronous-vs-async design decision.

**Why it's interesting externally**:
- Practical, small-scope Workers AI example (not a chatbot — a utility)
- Smart retry differentiation is a generally useful pattern
- Shows the trade-off: synchronous AI adds latency but guarantees data consistency

**Key code references**:
- Service: `apps/api/src/services/task-title.ts` — generation, retry, fallback
- Error classification: `classifyError()` — timeout vs rate-limit vs generic
- Markdown stripping: `stripMarkdown()` — post-processing LLM output

**Messaging hooks**: Workers AI practical usage, lightweight LLM integration
