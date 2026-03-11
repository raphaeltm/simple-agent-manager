# Technology Radar

**Last Updated**: 2026-03-11
**Update Trigger**: Quarterly

## Rings
- **Adopt**: Proven in our stack, recommended for continued/expanded use
- **Trial**: In use for specific purposes, evaluating for broader adoption
- **Assess**: Worth exploring, not yet committed
- **Hold**: Proceed with caution, or actively considering alternatives

## Techniques

| Technology | Ring | Rationale | Last Assessed |
|-----------|------|-----------|--------------|
| Serverless-first (Cloudflare Workers) | Adopt | Core architecture. Scales to zero, low ops burden, global edge. | 2026-03-11 |
| Durable Objects for stateful logic | Adopt | Per-project data isolation, embedded SQLite. Working well for chat, task state. | 2026-03-11 |
| BYOC (Bring-Your-Own-Cloud) | Adopt | Core differentiator. User credentials encrypted per-user. | 2026-03-11 |
| Dev Containers | Adopt | Industry standard for reproducible environments. Good ecosystem support. | 2026-03-11 |
| Warm node pooling | Trial | Reduces provisioning time. Three-layer defense against orphans. Needs optimization. | 2026-03-11 |
| ACP (Agent Communication Protocol) | Trial | Works for Claude Code. Need to validate for multi-agent scenarios. | 2026-03-11 |
| Structured logging (slog in Go) | Adopt | Clean observability in VM agent. Pairs well with Cloudflare Workers logs. | 2026-03-11 |

## Tools

| Technology | Ring | Rationale | Last Assessed |
|-----------|------|-----------|--------------|
| Vitest | Adopt | Fast, good Cloudflare Workers integration via `@cloudflare/vitest-pool-workers`. | 2026-03-11 |
| Drizzle ORM | Adopt | Type-safe, lightweight, D1-compatible. Working well. | 2026-03-11 |
| Pulumi | Adopt | Infrastructure-as-code for deployment. TypeScript-native. | 2026-03-11 |
| Playwright | Adopt | E2E testing for staging verification. Required by quality gates. | 2026-03-11 |
| Mastra | Trial | AI agent orchestration for Workers AI integration. Used for task title generation. | 2026-03-11 |
| Tailwind CSS v4 | Adopt | Recently adopted (spec 024). Consistent design system, good DX. | 2026-03-11 |

## Platforms

| Technology | Ring | Rationale | Last Assessed |
|-----------|------|-----------|--------------|
| Cloudflare Workers | Adopt | Core platform. Workers, D1, KV, R2, Durable Objects, Workers AI. | 2026-03-11 |
| Cloudflare D1 | Adopt | SQLite-based, serverless. Good for our scale. 10GB limit is fine for now. | 2026-03-11 |
| Hetzner Cloud | Adopt | Current (only) VM provider. Good price/performance. | 2026-03-11 |
| DigitalOcean | Assess | Strong candidate for second provider. Simple API, popular with developers. | 2026-03-11 |
| Vultr | Assess | Cheap VMs, global regions. Potential second/third provider. | 2026-03-11 |
| AWS/GCP | Hold | Enterprise providers but complex APIs, higher costs. Not priority for current audience. | 2026-03-11 |

## Languages & Frameworks

| Technology | Ring | Rationale | Last Assessed |
|-----------|------|-----------|--------------|
| TypeScript 5.x | Adopt | Primary language for API and web. Strong ecosystem. | 2026-03-11 |
| Go 1.24+ | Adopt | VM agent language. Good for system-level work, PTY management, WebSocket handling. | 2026-03-11 |
| React 18 | Adopt | Web UI framework. Stable, large ecosystem. | 2026-03-11 |
| Hono | Adopt | API framework on Workers. Lightweight, fast, good middleware. | 2026-03-11 |
| Vite 5 | Adopt | Build tool for web app. Fast HMR, good plugin ecosystem. | 2026-03-11 |
| React Router 6 | Adopt | Client-side routing. Works well with current architecture. | 2026-03-11 |
