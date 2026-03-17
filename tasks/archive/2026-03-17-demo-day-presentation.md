# Demo Day Presentation for SAM

## Problem Statement

Need a 10-slide presentation for demo day (March 19, 2026) targeting geeks and builders. Should highlight architectural decisions, the self-referential dev process (SAM built using SAM), and interesting nuggets from the git history.

## Research Findings

### Key Stats
- **991 commits** in 50 days (Jan 27 - Mar 17, 2026)
- **~20 commits/day** average, peak of 48 on Feb 28
- **115K lines of code** across TypeScript (637 files) + Go (105 files)
- **723 markdown docs**, 32 feature specs, 16 post-mortems, 16 agent rules
- **306 task files** tracked (183 archived)
- **444+ PRs**, ~30% authored by AI agents
- Solo developer + AI agents (Claude, Codex, SAM bot)

### Best Stories for the Audience
1. **The BetterAuth Saga** — 6 consecutive fix commits in 30 minutes on Feb 7 debugging GitHub OAuth on Cloudflare Workers
2. **CF Error 1003 Proxy Rabbit Hole** — multiple approaches to proxy workspace traffic through Cloudflare
3. **The Idle Shutdown Saga** — 10+ commits fighting systemd restart loops on VMs
4. **828 Tests Passing, Core Feature Broken** — the most dramatic post-mortem; all tests green but task execution didn't work
5. **TLS YAML Indentation** — one space of indentation broke all VM provisioning in production
6. **SAM Builds SAM** — /do workflow, dispatch_task, notifications, MCP tools all built because they were needed to build SAM
7. **Agent Authorship** — ~30% of commits by AI agents using the platform

### Architecture Highlights
- Cloudflare Workers (API) + Hetzner/Scaleway VMs (compute) + Durable Objects (state)
- BYOC model (Bring Your Own Cloud) — users provide their own cloud credentials
- ACP protocol for agent communication
- Cloud-init templates for VM bootstrapping
- Multi-agent support (Claude Code, Codex, Mistral Vibe)

## Implementation Checklist

- [x] Create reveal.js HTML presentation in `docs/presentations/`
- [x] Slide 1: Title — SAM: Simple Agent Manager
- [x] Slide 2: What is SAM? (elevator pitch)
- [x] Slide 3: Architecture (Cloudflare Workers + VMs + DOs diagram)
- [x] Slide 4: The Numbers (991 commits, 50 days, solo + AI)
- [x] Slide 5: Dogfooding — SAM Builds SAM
- [x] Slide 6: War Story — The BetterAuth Saga
- [x] Slide 7: War Story — 828 Tests Passing, Core Feature Broken
- [x] Slide 8: The Learning Machine (16 post-mortems, evolving rules)
- [x] Slide 9: Multi-Cloud, Multi-Agent
- [x] Slide 10: Live Demo / What's Next

## Acceptance Criteria

- [x] 10-slide HTML presentation using reveal.js
- [x] Focused on technical audience (geeks and builders)
- [x] Includes real git history nuggets and stats
- [x] Highlights the self-referential development process
- [x] Presentable in a browser with no build step required
