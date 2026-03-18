# Aspirational Style Guide — LOTR-Themed Developer Brand

**Created**: 2026-03-17
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Medium

## Context

SAM (Simple Agent Manager) is named after Samwise Gamgee from Lord of the Rings — the loyal, dependable companion who makes the impossible journey possible. This naming connection has not been visually or thematically expressed in the current design. The current UI is functional and developer-focused (dark theme, sage green palette, minimal decoration) but lacks distinctive personality.

## Problem Statement

Create an aspirational style guide that:
1. Researches best practices in developer-oriented design and marketing
2. Analyzes the current SAM design language
3. Proposes an aspirational brand identity that blends LOTR theming with developer culture
4. Provides actionable design tokens, naming conventions, and copy guidelines
5. Serves as a north star for future implementation

## Research Findings

### Developer-Oriented Design Best Practices (2025-2026)
- **Evil Martians study**: Analyzed 100+ dev tool landing pages — simplicity wins, avoid sales-heavy messaging, centered layouts, clean typography
- **Dark-mode-first**: Developer tools (Linear, Vercel, Supabase, Warp) all default to dark themes
- **Design tokens**: Treat colors/spacing/typography as "global constants" on 8pt grid
- **Micro-interactions**: Confirm actions without interrupting flow
- **Action-oriented copy**: "Generate Report" not "Submit"
- **Product-led growth**: Developers want to try before they buy — no gates, no friction

### Developer Marketing Principles
- Trust through utility, not hype
- Technical accuracy is non-negotiable
- Authenticity is the moat (Supabase grew from 1M to 4.5M devs on this)
- Community-first distribution

### LOTR-Themed Tech Companies (Precedent)
- Palantir (seeing stones → data analysis)
- Anduril (reforged sword → defense tech)
- Mithril Capital (precious metal → venture capital)
- Tolkien's names work because they're linguistically rigorous and feel "earned"

### Current SAM Design Language
- Dark theme with sage green (#0b1110 canvas, #16a34a accent)
- System fonts (no custom typeface)
- 6-tier typography scale, 8pt-adjacent spacing
- Minimal decoration, functional UI
- Tokyo Night terminal palette
- Chat-first UX, command palette (Cmd+K)
- Copy tone: professional, developer-native, no fluff

## Implementation Checklist

- [x] Research developer-oriented design best practices
- [x] Research developer marketing and branding approaches
- [x] Research LOTR-themed tech naming conventions
- [x] Analyze current SAM design language and UI
- [x] Create aspirational style guide document

## Acceptance Criteria

- [ ] Style guide covers: color palette, typography, naming conventions, copy voice, component patterns, LOTR theming rationale
- [ ] Guide references real-world developer tool examples
- [ ] Guide is actionable — designers/developers could implement from it
- [ ] Published in `strategy/marketing/` directory

## References

- Evil Martians: "We studied 100 dev tool landing pages" (2025)
- Vercel Geist Design System
- Supabase brand voice and growth strategy
- Current SAM theme: `packages/ui/src/tokens/theme.css`
- Current SAM landing: `apps/web/src/pages/Landing.tsx`
