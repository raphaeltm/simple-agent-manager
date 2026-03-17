# Update WWW Homepage with Current Features

## Problem

A previous agent (PR #430) correctly identified shipped features that should be visible on the public landing page, but updated `apps/web/src/pages/Landing.tsx` (the login/sign-in page) instead of the actual public marketing site at `apps/www/`. The www site now has outdated content that doesn't reflect shipped features like Mistral Vibe support, Scaleway multi-cloud, chat-driven tasks, notifications, voice input, conversation forking, and more.

## Research Findings

### Current www site state (outdated areas):
- **Hero** (`Hero.astro`): Mentions "Claude Code, Codex, or Gemini CLI" — missing Mistral Vibe
- **SocialProof** (`SocialProof.astro`): Shows only 3 agents — missing Mistral Vibe
- **Features** (`Features.astro`): 6 general feature cards — doesn't mention specific shipped features like notifications, voice/TTS, conversation forking, command palette, warm pooling, AI task titles, session suspend/resume
- **HowItWorks** (`HowItWorks.astro`): 3-step flow (Connect → Create Workspace → Manage) — outdated, should reflect chat-driven task workflow (Connect → Create Project → Describe Task → Watch It Build)
- **Vision** (`Vision.astro`): Lists "Multi-Cloud Providers" as planned — now shipped (Hetzner + Scaleway). "Cross-Workspace Monitoring" marked shipped but description is stale.
- **Comparison** (`Comparison.astro`): Agent choice says "Claude Code, Codex, Gemini CLI" — missing Mistral Vibe. Monthly cost only mentions Hetzner.
- **Roadmap** (`Roadmap.astro`): "Multi-Cloud & CLI" listed as planned — multi-cloud is now shipped. Missing recent shipped features.

### Content from Landing.tsx to port:
- 4 agents: Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe
- Multi-cloud: Hetzner & Scaleway
- 4-step workflow: Connect Cloud → Create Project → Describe Task → Watch It Build
- 9 platform features: Chat-Driven Tasks, Real-Time Notifications, Voice Input & TTS, Conversation Forking, Port Exposure, Global Command Palette, Warm Node Pooling, AI Task Titles, Session Suspend & Resume
- BYOC with both Hetzner (EU & US) and Scaleway (Paris, Amsterdam, Warsaw)
- Updated shipped/planned roadmap

### Design constraints:
- Astro components with scoped CSS
- Dark theme with green accent (`--color-accent: #16a34a`)
- Chillax display font, system body font, monospace for labels
- `animate-on-scroll` class for scroll-triggered animations
- Existing section patterns: section-label, section-title, section-subtitle
- Cards with `--color-bg-surface` background, `--color-border-subtle` border

## Implementation Checklist

- [ ] Update `Hero.astro`: Add Mistral Vibe to subtitle text, mention 4 agents
- [ ] Update `SocialProof.astro`: Add Mistral Vibe as 4th agent with icon
- [ ] Update `Features.astro`: Add new shipped platform features (9 feature cards from Landing.tsx) while keeping the existing 6 core features
- [ ] Update `HowItWorks.astro`: Change to 4-step chat-driven workflow matching Landing.tsx
- [ ] Update `Vision.astro`: Mark multi-cloud as shipped, update planned items, add new shipped items
- [ ] Update `Comparison.astro`: Add Mistral Vibe to agent choice, mention Scaleway in cost row
- [ ] Update `Roadmap.astro`: Add new completed phases for recent features, update planned items
- [ ] Verify all changes maintain existing design patterns and CSS consistency

## Acceptance Criteria

- [ ] All 4 agents (Claude Code, Codex, Gemini CLI, Mistral Vibe) appear in Hero, SocialProof, Comparison
- [ ] How It Works reflects the chat-driven 4-step workflow
- [ ] Multi-cloud (Hetzner + Scaleway) is shown as shipped, not planned
- [ ] New platform features are visible on the homepage
- [ ] Existing design aesthetic is preserved (dark theme, green accent, Chillax font, animations)
- [ ] Site builds without errors (`pnpm build` in apps/www)
- [ ] No broken links or missing content

## References

- Landing.tsx (source of correct content): `apps/web/src/pages/Landing.tsx`
- PR #430: Previous agent's changes to Landing.tsx
- Chat session: `5eafefbf-061a-4f12-bebe-2f0b37c7f5c3`
