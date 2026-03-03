# README Rewrite: Compelling Value Prop + Quick Deploy

## Problem

The current README is 449 lines of documentation-style content (API reference, keyboard shortcuts, full architecture diagram, security details) instead of a compelling landing page that sells the project and gets users deploying fast.

## Research Findings

Analyzed 6 similar open-source projects (E2B, Daytona, Gitpod, Coder, OpenHands, Runloop):
- **Best READMEs are 150-200 lines** (500-800 words of content)
- **Lead with tagline + badges + nav links** (Coder pattern)
- **Copy-paste quickstart under 5 steps** (Coder's 3-command Docker start is gold standard)
- **Quantitative claims beat adjectives** (Daytona: "sub-90ms", OpenHands: "77.6% SWE-bench")
- **No architecture diagrams in README** — link to docs instead
- **Features: 4-6 bullets, one line each** with concrete details
- **One screenshot or GIF** showing the product in action

## Implementation Checklist

- [ ] Remove: keyboard shortcuts section, full API reference, security details, detailed architecture diagram, project structure, tech stack table, use cases section, roadmap table
- [ ] Add: nav links row (Quick Deploy | Docs | Architecture | Contributing)
- [ ] Rewrite value prop: focus on "self-hosted AI coding environments" angle
- [ ] Keep comparison table but make it punchier
- [ ] Rewrite features: 5-6 concise bullets with concrete details
- [ ] Rewrite quickstart as "Quick Deploy" with the fork-configure-push flow (automated deployment)
- [ ] Add brief "How It Works" section with text (link to architecture docs)
- [ ] Add "Development" section (brief, for contributors)
- [ ] Link to self-hosting guide for detailed instructions
- [ ] Keep under 200 lines total

## Acceptance Criteria

- [ ] README is under 200 lines
- [ ] Leads with compelling value prop, not documentation
- [ ] Quick deploy section uses the automated GitHub Actions flow
- [ ] No keyboard shortcuts, API reference, or security details in README
- [ ] Links to docs for detailed information
- [ ] Passes lint/typecheck (no code changes, but verify build)
