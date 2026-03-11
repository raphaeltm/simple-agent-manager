# Feature Comparison Matrix

**Last Updated**: 2026-03-11
**Update Trigger**: When any competitor ships a notable feature

## Core Platform Features

| Feature | SAM | Coder | Ona (Gitpod) | Daytona | Codespaces | DevPod |
|---------|-----|-------|-------------|---------|-----------|--------|
| Cloud dev environments | Yes | Yes | Yes | Partial (sandboxes) | Yes | Yes |
| AI agent execution | Yes | Yes | Yes | Yes (sandbox-only) | No | No |
| Autonomous task execution | Yes | Yes (Mux) | Yes (Background Agents) | No | No | No |
| BYOC (user's own cloud) | Yes | Partial (self-hosted) | No | Partial (customer compute) | No | Yes |
| Self-hostable control plane | Yes (Cloudflare) | Yes (any infra) | No (SaaS) | Partial (control plane hosted) | No | Yes (client-only) |
| Dev Container support | Yes | Yes | Yes | Partial | Yes | Yes |
| Chat-first UX | Yes | No | No | No | No | No |
| Task/project management | Yes | No | Partial (automations) | No | No | No |
| Warm node pooling | Yes | Unknown | Unknown | N/A (90ms start) | Yes (prebuilds) | No |
| Multi-workspace per node | Yes | Yes | Unknown | N/A | No | No |

## AI Agent Support

| Feature | SAM | Coder | Ona | Daytona | Codespaces | DevPod |
|---------|-----|-------|-----|---------|-----------|--------|
| Claude Code support | Yes | Via IDE | Unknown | Via API | Via Copilot | Manual |
| Multiple agent types | Yes (architecture) | Yes | Yes (own agent) | Agent-agnostic | Copilot only | N/A |
| Agent credential injection | Yes | Yes | Yes | Via API | N/A | Manual |
| Agent OAuth support | Yes | Unknown | Unknown | N/A | N/A | N/A |
| Agent session persistence | Yes | Unknown | Yes | Yes (snapshots) | N/A | N/A |
| Parallel agent execution | Partial | Yes (Mux) | Yes (fleets) | Yes | No | No |

## Infrastructure & Security

| Feature | SAM | Coder | Ona | Daytona | Codespaces | DevPod |
|---------|-----|-------|-----|---------|-----------|--------|
| VM-level isolation | Yes | Yes | Unknown | Optional (Kata) | Yes | Provider-dependent |
| User credential encryption | Yes (per-user) | Yes | Yes | Yes | N/A | N/A |
| SOC 2 | No | Yes | Yes | Unknown | Yes | N/A |
| VPC deployment | No | Yes | Yes | Yes | N/A | Yes |
| Air-gapped support | No | Yes | No | Yes | No | Yes |
| Audit logging | Partial | Yes | Yes | Yes | Yes | No |

## Pricing Model

| Aspect | SAM | Coder | Ona | Daytona | Codespaces | DevPod |
|--------|-----|-------|-----|---------|-----------|--------|
| Model | Self-hosted (BYOC) | Free/Enterprise | Free/Enterprise | Usage-based | Per-hour | Free (OSS) |
| Free tier | Self-hosted | Community (free) | Yes | $200 credits | 120 core-hrs/mo | Free |
| Cost to user | Own cloud costs only | Free or contact sales | Contact sales | ~$0.067/hr (1 vCPU) | $0.18-$2.88/hr | Own cloud costs |

## Provisioning Speed

| Platform | Cold Start | Warm Start |
|----------|-----------|-----------|
| SAM | Minutes (VM provisioning) | Seconds (warm pool) |
| Coder | Minutes (Terraform apply) | Seconds (stopped workspace) |
| Ona | Unknown | Unknown |
| Daytona | 27-90ms | Instant (snapshots) |
| Codespaces | 30-90 seconds | 10-20 seconds (prebuilds) |
| DevPod | Minutes (provider-dependent) | Seconds (stopped) |

## Legend
- **Yes**: Fully supported, verified
- **Partial**: Limited support or in development
- **No**: Not supported
- **Unknown**: Could not verify from public sources
- **N/A**: Not applicable to this product category
