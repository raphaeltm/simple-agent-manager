# Competitive Positioning Map

**Last Updated**: 2026-03-11
**Update Trigger**: When a competitor pivots positioning or enters a new segment

## Primary Positioning Map

**Axes**: Infrastructure Control (User-managed ← → Vendor-managed) vs AI Agent Capability (None ← → Fully Autonomous)

```
                      Fully Autonomous AI Agents
                              ▲
                              │
                    Ona ●     │     ● Devin
                              │
               Coder ●        │
                              │
          SAM ●               │
                              │
                              │
 User-managed ◄───────────────┼───────────────► Vendor-managed
 Infrastructure               │                 Infrastructure
                              │
      DevPod ●                │        ● Codespaces
                              │
                              │        ● Replit
                              │
                    Daytona ● │
                              │
                              ▼
                      No AI Agent Capability
```

### Reading the Map

- **Top-left (User infra + AI agents)**: SAM, Coder — give users infrastructure control AND AI agent capabilities. This is the "enterprise BYOC agent" quadrant.
- **Top-right (Vendor infra + AI agents)**: Ona, Devin — fully managed platforms with autonomous agents. Enterprise SaaS model.
- **Bottom-left (User infra + no agents)**: DevPod — pure infrastructure, no AI. Open source.
- **Bottom-right (Vendor infra + no agents)**: Codespaces, Replit — managed CDEs without autonomous agent focus.
- **Bottom-center**: Daytona — fast sandboxes for AI execution but not full agent orchestration.

## Secondary Positioning Map

**Axes**: Target User (Individual Developer ← → Enterprise) vs Product Scope (Infrastructure Only ← → Full Workflow)

```
                         Full Workflow
                              ▲
                              │
                   SAM ●      │       ● Ona
                              │
                              │       ● Codespaces
                              │
                              │
 Individual ◄─────────────────┼─────────────────► Enterprise
 Developer                    │
                              │
            DevPod ●          │       ● Coder
                              │
              Daytona ●       │
                              │
                              ▼
                      Infrastructure Only
```

### SAM's Sweet Spot

SAM currently occupies the **individual-to-small-team, full-workflow** quadrant — offering more than just infrastructure (task management, chat UX, project organization) but not yet at enterprise scale. The path to growth runs rightward (enterprise features like SOC 2, VPC deployment, audit logging) while maintaining the workflow advantage.

## Gaps and Opportunities

1. **No competitor combines BYOC + chat-first UX + AI agents** — SAM's unique position
2. **Enterprise governance gap** — SAM lacks SOC 2, VPC deployment, audit logging that Coder and Ona offer
3. **Provisioning speed gap** — SAM's VM provisioning is minutes; Daytona is milliseconds
4. **Multi-agent gap** — Coder Mux and Ona both support parallel agent execution at scale; SAM is single-agent per workspace
