# Pricing Analysis

**Last Updated**: 2026-03-11
**Update Trigger**: Quarterly, or when a competitor changes pricing

## Competitor Pricing Landscape

| Competitor | Model | Free Tier | Paid Tier | Enterprise |
|-----------|-------|-----------|-----------|-----------|
| Coder | Open core + enterprise | Community (free, OSS) | Premium (contact sales) | Custom contracts |
| Ona (Gitpod) | Freemium + enterprise | "Start for free" | Unknown | Contact sales (Fortune 500) |
| Daytona | Usage-based | $200 free credits | ~$0.067/hr (1 vCPU) | Startup credits up to $50K |
| GitHub Codespaces | Per-hour + storage | 120 core-hrs/month | $0.18-2.88/hr + $0.07/GB/mo | Included in GH Enterprise |
| DevPod | Free (OSS) | Free (client-only) | N/A | N/A |
| Cursor | Per-seat subscription | Free (limited) | Pro $20/user/mo | Business $40/user/mo |

## Value Metric Analysis

**What do users pay for in this market?**

| Value Metric | Used By | SAM Fit |
|-------------|---------|---------|
| Per-seat/month | Cursor, Coder Enterprise | Medium — SAM is infra, not an IDE |
| Per-hour compute | Codespaces, Daytona | Low — BYOC means compute is user's cost |
| Managed control plane | Potential SAM Cloud | High — the value SAM adds is orchestration |
| Enterprise features | Coder, Ona | High — SSO, RBAC, audit are clear upsells |

**SAM's value metric should be: managed control plane access (per-seat/month)**. The compute cost is already on the user's cloud account (BYOC), so SAM charges for orchestration, UX, and agent management.

## Recommended Pricing (Draft)

### Tier Structure

| Tier | Price | Includes | Target Segment |
|------|-------|---------|---------------|
| **Self-Hosted** | Free | Full platform, self-hosted on own Cloudflare account | Individual developers, OSS contributors |
| **SAM Cloud** | $25/user/month | Managed control plane, BYOC for VMs, community support | Small teams, individual professionals |
| **SAM Team** | $50/user/month | SAM Cloud + team management, shared projects, priority support | Growing teams (5-20 developers) |
| **SAM Enterprise** | Custom | Team + SSO/SAML, RBAC, audit logging, SLA, dedicated support | Enterprise (20+ developers) |

### Justification

- **Free tier** preserves BYOC/open-source positioning — critical for developer trust and community growth
- **$25/user/month** undercuts Codespaces ($0.18/hr = ~$36/month at 8hr/day) while adding AI agent orchestration
- **$50/user/month** aligns with Cursor Pro ($20) + Codespaces (~$36) combined value
- **Enterprise** follows Coder/Ona model — contact sales, custom pricing for compliance features

### Sensitivity Analysis

| Scenario | Price Change | Expected Impact |
|---------|-------------|----------------|
| SAM Cloud at $15/mo (vs $25) | -40% | Higher adoption, lower ARPU, may signal "cheap" |
| SAM Cloud at $40/mo (vs $25) | +60% | Lower adoption, need stronger differentiation |
| Add usage component ($0.01/agent-session) | Variable | Better value alignment but complex for BYOC |
| Annual discount (20% off) | -20% effective | Standard SaaS — improves retention, cash flow |

## Open Questions

1. Does BYOC model support a managed tier? Users self-host VMs but SAM hosts the control plane — is this a natural split?
2. Should there be a per-project or per-workspace limit on free tier to encourage upgrade?
3. Is the AI agent execution the value (charge per session) or the platform (charge per seat)?
