# Engineering Roadmap

**Last Updated**: 2026-03-11
**Update Trigger**: Start of each planning cycle or major strategic shift

## Now (Active / In Progress)

| Initiative | Goal | Status | Business Driver |
|-----------|------|--------|----------------|
| Chat message parity (spec 026) | Full message rendering parity with Claude Code | In Progress | Core UX quality — chat is the primary interface |
| ACP session error observability | Reliable error surfacing for agent sessions | In Progress | Users can't debug failures without this |
| Task UI/UX polish | Smooth task submission and tracking flow | In Progress | Task-driven workflow is a key differentiator |
| Mobile navbar redesign | Usable mobile experience | In Progress | Access from any device |
| Loading state patterns | Consistent loading UX across the app | In Progress | Polish and perceived performance |

## Next (Planned, Not Started)

| Initiative | Goal | Depends On | Business Driver |
|-----------|------|-----------|----------------|
| Multi-provider support | Add providers beyond Hetzner (DigitalOcean, Vultr, GCP, etc.) | Provider abstraction layer | Expand addressable market — BYOC means supporting user's preferred cloud |
| Marketing website | Public-facing site for SAM | Positioning doc (done) | User acquisition — currently no landing page |
| Warm pool optimization | Faster workspace startup via improved warm node reuse | Current warm pool stability | Provisioning speed is a competitive weakness (minutes vs Daytona's 90ms) |
| Multi-agent support | Run agents beyond Claude Code (Cursor, Codex, custom) | Agent abstraction architecture | Agent-agnostic positioning — reduce single-vendor risk |
| Persistent terminal sessions | Terminal sessions survive page refresh reliably | PTY session work | Developer experience continuity |
| VM agent binary auto-update | In-place binary updates without reprovisioning | VM agent architecture | Operational efficiency, faster deployments |

## Later (Backlog, Prioritized)

| Initiative | Goal | Business Driver | Effort |
|-----------|------|----------------|--------|
| Team/organization support | Multi-user workspaces, shared projects, RBAC | Revenue (Team tier pricing) | L |
| SSO/SAML | Enterprise authentication | Revenue (Enterprise tier) | M |
| Audit logging | Compliance-grade activity logging | Enterprise sales requirement | M |
| Parallel agent execution | Multiple agents working on same project | Competitive parity with Coder Mux, Ona fleets | XL |
| SOC 2 compliance | Certification for enterprise trust | Enterprise sales requirement | XL |
| Desktop app | Native app wrapper for better UX | User experience, competitive parity | L |
| MCP server marketplace | User-configurable MCP servers for agents | Agent extensibility | M |
| Project runtime env/files | Inject custom env vars and files into workspaces | Developer workflow flexibility | S |

## Decisions Needed

1. **Provider expansion order** — Which cloud provider after Hetzner? DigitalOcean (popular, easy API), Vultr (cheap), or GCP/AWS (enterprise)?
2. **Managed hosting (SAM Cloud)** — Do we build a hosted tier, or stay self-host only? Affects architecture decisions.
3. **Multi-agent architecture** — Do we abstract at the agent protocol level (ACP) or at the workspace level?
4. **Enterprise investment timing** — When do SSO/RBAC/audit become priority over feature development?

## Completed (Recent)

| Initiative | Completed | Impact |
|-----------|----------|--------|
| Chat-first UX (spec 022) | 2026-03 | Project page is now a chat interface |
| Task-driven architecture (spec 021) | 2026-03 | Autonomous task execution with warm pooling |
| Admin observability (spec 023) | 2026-03 | Error dashboard, log viewer, health monitoring |
| Tailwind adoption (spec 024) | 2026-03 | Consistent design system |
| Node observability (spec 020) | 2026-02 | Structured logging, system info collection |
