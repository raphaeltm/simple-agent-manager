# Business Model Canvas

**Last Updated**: 2026-03-11
**Update Trigger**: When revenue model or target market changes

## Canvas

| Block | Description |
|-------|------------|
| **Value Propositions** | BYOC infrastructure for AI coding agents — users keep control of their cloud, credentials, and costs. Chat-first UX for autonomous task execution. Self-hostable on Cloudflare Workers. No vendor lock-in to a specific AI agent or cloud provider. |
| **Customer Segments** | **Primary**: Individual developers and small teams who want AI coding agents on their own infrastructure. **Secondary**: DevOps/platform engineers building internal developer platforms. **Future**: Enterprises needing governed AI agent execution with BYOC. |
| **Channels** | Open source / self-hosting guide. Developer communities (HN, Reddit, Discord). Technical blog content. GitHub presence. Word of mouth from early adopters. |
| **Customer Relationships** | Community-driven (Discord, GitHub issues). Self-service documentation. Open source contribution model. |
| **Revenue Streams** | **Current**: None (pre-revenue, self-hosted). **Near-term options**: Managed hosting tier (SAM Cloud), enterprise support/SLA, premium features (team management, SSO, audit logging). **Model**: Freemium — open-source core + paid cloud/enterprise tier. |
| **Key Resources** | Cloudflare Workers infrastructure. Open-source codebase. Claude Code integration expertise. Developer community. |
| **Key Activities** | Platform development. Open-source community building. Cloud provider integrations. Security and compliance hardening. |
| **Key Partnerships** | Anthropic (Claude Code agent). Cloudflare (infrastructure). Hetzner (default cloud provider). Potential: other cloud providers, other AI agent providers. |
| **Cost Structure** | Development time (primary). Cloudflare Workers usage (minimal — serverless). No cloud infrastructure costs (BYOC model passes to users). Community/marketing effort. |

## Revenue Model Options

### Option A: Managed Hosting (SAM Cloud)
- Host the control plane; users still BYOC for VMs
- Pricing: $20-50/user/month for the managed control plane
- Advantage: Recurring revenue, lower friction than self-hosting
- Risk: Competing with "just self-host it for free"

### Option B: Enterprise Tier
- Self-hosted but with enterprise features (SSO, RBAC, audit logging, SOC 2, SLA)
- Pricing: $50-100/user/month or annual contract
- Advantage: High ARPU, clear value differentiation
- Risk: Requires significant compliance/security investment

### Option C: Usage-Based (Daytona model)
- Charge per compute-hour or per agent-session
- Pricing: Based on resource consumption
- Advantage: Aligns cost with value, low barrier to entry
- Risk: BYOC model makes metering complex (compute is on user's cloud)

### Recommended Path
Start with **Option A** (managed hosting) to prove product-market fit and generate initial revenue, then layer on **Option B** (enterprise features) as the product matures. Option C is less natural for BYOC.

## Key Assumptions

1. Developers want BYOC rather than vendor-managed infrastructure for AI agents
2. Chat-first UX is a meaningful differentiator vs. CLI-only or IDE-only approaches
3. Self-hosting on Cloudflare Workers is viable for the control plane at scale
4. Claude Code remains a leading AI coding agent (not commoditized away)
