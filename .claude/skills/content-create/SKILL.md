---
name: content-create
description: Content creation from strategy artifacts. Drafts social media posts, blog outlines, changelog announcements, product launch copy, and developer content. Trigger when asked to write social posts, blog content, announcements, launch copy, or atomize strategy docs into publishable content.
user-invocable: true
---

# Content Creation

Transform strategy documents, product changes, and competitive insights into publishable content drafts.

## Prerequisites — Read These First

Before creating ANY content:
1. Read `strategy/content/style-guide-raph.md` for Raph's personal writing style
2. Read `strategy/marketing/messaging-guide.md` for voice, tone, approved language
3. Read `strategy/marketing/positioning.md` for core positioning and differentiators
4. Read `strategy/competitive/` for competitive context
5. For changelogs: check `git log`, recent PRs, and `specs/`
6. For technical content: read relevant source code and architecture docs

**Never create content without reading the style guide and messaging guide first.**

## Personal Hook Requirement

Every blog post and long-form piece needs a personal hook — a real story, experience, or observation from Raph that grounds the piece. Before writing:

1. Search the repo for relevant context: `docs/notes/`, `tasks/`, commit history, PR descriptions, post-mortems
2. Check `strategy/content/` for any existing notes or hooks the human may have left
3. **If you cannot find a personal story or hook in the repo, ASK the human before writing.** Say something like: "I have the technical content but I need a personal angle. Do you have a story about how this came up, what prompted it, or what surprised you?"

Do NOT fabricate personal stories. Do NOT substitute a generic "as developers, we all know..." opening. If there's no personal hook available, ask for one.

## Content Types

### Social Media Posts
Generate 2-3 variants per message. Adapt for each platform:
- **LinkedIn** — Professional, longer-form, insight-driven, question to drive engagement
- **Twitter/X** — Concise and punchy. Thread format for complex topics. Single-tweet variant too.
- **Hacker News** — Technical, understated, honest about trade-offs, invite feedback
- **Reddit** — Community-appropriate, helpful, focused on solving problems not promoting

### Blog Post Outlines
Structure: Hook, Problem, Our Approach, Implementation/How-To, Results/Evidence, CTA. Include target audience, pillar theme, SEO target, and key points with sources.

### Changelog / Release Announcements
Generated from git history, PRs, and feature specs. Format: What's New (feature name + why it matters + how it works), Improvements, Fixes.

### Product Launch Copy
Headline options (benefit/problem/curiosity focused), subheadline, hero section, key benefits with proof points, social proof, CTA (primary + secondary), email announcement draft.

### Developer Content (Diataxis Framework)
Identify which type: Tutorial (learning), How-to Guide (task), Explanation (understanding), Reference (information).

## Content Atomization

From one source, produce multiple pieces:
- Blog post (long-form) → LinkedIn post → Twitter thread → Single tweet → HN submission → Email snippet → Internal announcement

## Output

Save drafts to `strategy/content/drafts/YYYY-MM-DD-[topic].md`
Save reusable templates to `strategy/content/templates/`

## Quality Standards

- Consistent with messaging guide voice and tone
- Uses approved language (not banned terms)
- Differentiators are evidence-backed
- CTA is clear and channel-appropriate
- Platform-native formatting (LinkedIn != Twitter != HN)
- No unverified competitive claims
- Always provide 2-3 variants for headlines, hooks, and CTAs
- Aim for 70-80% ready — human adds brand taste and final polish
