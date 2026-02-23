# Marketing Site Messaging Overhaul

**Created**: 2026-02-23
**Priority**: High
**Classification**: `ui-change`, `public-surface-change`

## Context

The current marketing site at `apps/www/` positions SAM primarily as a cheaper GitHub Codespaces alternative. The hero shows a fake CLI terminal (`sam init`, `sam create`) that doesn't exist, and the messaging is cost-centric. The market has shifted — competitors (Coder, Gitpod/Ona, Devin) are all pivoting to "AI agent infrastructure." SAM's real differentiator is multi-agent orchestration on user-owned infrastructure, and the site should reflect that.

## Goals

1. Remove the fake CLI terminal from the hero
2. Shift primary messaging from cost to agent orchestration on your own infra
3. Add a prominent "Vision" section showcasing upcoming capabilities
4. Keep the existing design system (dark green, Chillax font, clean sections)
5. Update roadmap to reflect current state and vision
6. Add CLI to backlog/roadmap as a planned feature

## Implementation Plan

### Hero Section (`Hero.astro`)
- [ ] New headline: "Orchestrate AI coding agents on your own cloud"
- [ ] New subtitle focused on multi-agent support + structured visibility + BYOC
- [ ] Replace fake CLI terminal with a product-style workspace mockup (CSS art showing agent chat UI with tool calls, permissions, diffs)
- [ ] Keep both CTAs (Get Started + GitHub)

### Features Section (`Features.astro`)
- [ ] Restructure 6 feature cards around new pillars:
  1. Multi-Agent Support (Claude, Codex, Gemini)
  2. Structured Agent Visibility (ACP protocol — tool calls, diffs, permissions)
  3. Bring Your Own Cloud (encrypted credentials, data sovereignty)
  4. Project-Centric Workflows (coming — sessions, tasks, activity)
  5. Multi-Workspace Nodes (cost efficiency through consolidation)
  6. Open Source & Self-Hostable (MIT, Cloudflare free tier)

### New "Vision" Section (new component `Vision.astro`)
- [ ] Create a prominent section between HowItWorks and Comparison
- [ ] Showcase upcoming capabilities with visual treatment:
  - Project-first architecture with persistent chat sessions
  - Cross-workspace task management and agent monitoring
  - Multi-cloud provider support (DigitalOcean, Vultr, AWS, etc.)
  - CLI for power users
  - Teams and collaboration
- [ ] Use a card or two-column layout with "Coming Soon" badges

### Comparison Section (`Comparison.astro`)
- [ ] Reframe from "Cut your cloud dev costs in half" to something like "The full picture"
- [ ] Add rows for multi-agent support, structured visibility, open source
- [ ] Keep cost row but as one of many advantages, not the headline
- [ ] Reduce prominence of the ~50% cost callout (smaller or remove)

### Roadmap Section (`Roadmap.astro`)
- [ ] Update phases to reflect current state:
  - MVP (Complete)
  - Browser Terminal & Agent Chat (Complete)
  - Multi-Agent Protocol (Complete)
  - Multi-Workspace Nodes (Complete)
  - Project-First Architecture (In Progress)
  - Multi-Cloud & CLI (Planned)
  - Teams & Enterprise (Planned)

### SocialProof Section (`SocialProof.astro`)
- [ ] Update "BUILT WITH" badges to include agent support
- [ ] Add Claude Code, Codex, Gemini CLI badges

### Page Layout (`index.astro`)
- [ ] Add Vision component import
- [ ] Insert Vision section after HowItWorks, before Comparison

### Backlog Task
- [ ] Create `tasks/backlog/2026-02-23-cli-tool.md` for the CLI feature

## Acceptance Criteria

- [ ] No fake CLI terminal in the hero
- [ ] Primary messaging is about agent orchestration on your infrastructure
- [ ] Cost is mentioned but not the headline focus
- [ ] Vision section prominently showcases upcoming capabilities
- [ ] Roadmap reflects actual state with agent orchestration phases
- [ ] Design system preserved (colors, fonts, spacing, animations)
- [ ] Site builds cleanly (`pnpm --filter @simple-agent-manager/www build`)
- [ ] Deployed and verified on www.simple-agent-manager.org
