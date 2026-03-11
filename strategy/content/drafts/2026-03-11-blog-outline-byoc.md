# Blog: Why We Built BYOC Infrastructure for AI Coding Agents

**Target Audience**: Developers evaluating AI coding agent platforms
**Pillar Theme**: BYOC / Infrastructure control
**Goal**: Reader understands why BYOC matters and considers SAM
**SEO Target**: "BYOC AI coding agents", "self-hosted AI coding infrastructure"

## Outline

### Hook
The AI coding tool market hit $8.5B in 2026. Every major platform wants your code on their servers. We went the opposite direction.

### Problem
When you use a managed AI coding platform, you're handing over:
- Your source code (runs on their infrastructure)
- Your cloud credentials (they provision on your behalf — or on theirs)
- Your cost control (their pricing, their metering)
- Your data sovereignty (where does your code live?)

For hobby projects, this is fine. For production codebases, it's a real concern.

### The BYOC Alternative
BYOC (Bring Your Own Cloud) means the platform orchestrates, but YOU own the infrastructure:
- Your cloud account, your API tokens
- Your VMs, your network, your region choices
- Your costs — predictable, on your cloud bill
- Your credentials — encrypted per-user, never leave your infra

### How SAM Does It
Walk through the architecture:
1. User provides Hetzner token (encrypted, stored per-user in D1)
2. SAM's control plane (Cloudflare Workers) orchestrates provisioning
3. VMs provisioned on USER'S Hetzner account
4. Devcontainer spun up, Claude Code started
5. Task runs, PR created, workspace cleaned up
6. SAM never has cloud credentials at the platform level

### Trade-offs (honest section)
- Slower provisioning than managed platforms (minutes vs seconds/ms)
- User needs a cloud account (Hetzner for now)
- More setup than "just click Start" (self-hosting required)
- We think these trade-offs are worth it for the control you get

### Who This Is For
- Developers who care about where their code runs
- Teams with compliance requirements
- Anyone who's been burned by vendor lock-in or surprise cloud bills
- r/selfhosted community members who want AI agents on their terms

### CTA
Try it: link to self-hosting guide
Star it: link to GitHub repo
Discuss: link to community (Discord/GitHub Discussions)

## Key Points to Include
- [ ] Market data: $8.5B AI coding tools market, 62% developer adoption
- [ ] Competitor comparison: managed (Ona, Codespaces) vs self-hosted (Coder, SAM)
- [ ] Architecture diagram (Mermaid) showing BYOC data flow
- [ ] Code snippet: how credentials are encrypted (reference credential-security.md)
- [ ] Honest trade-off table
