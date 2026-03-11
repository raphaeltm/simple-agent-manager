---
name: content-create
description: "Content creation from strategy artifacts. Drafts social media posts, blog outlines, changelog announcements, product launch copy, and developer content. Atomizes strategy docs into platform-specific content. Use when creating marketing content, writing announcements, or turning strategy into published artifacts."
---

# Content Creation

Transform strategy documents, product changes, and competitive insights into publishable content drafts.

## When to Use

- Drafting social media posts (LinkedIn, Twitter/X, HN, Reddit)
- Writing blog post outlines or full drafts
- Creating changelog/release announcements from engineering output
- Producing product launch copy (landing page, emails, announcement posts)
- Generating developer documentation or tutorials
- Atomizing a single piece of content into multiple formats
- Building newsletter content from recent changes

## Workflow

### 1. Gather Source Material

Before creating any content, load the strategic context:
- Read `strategy/marketing/positioning.md` for core positioning and differentiators
- Read `strategy/marketing/messaging-guide.md` for voice, tone, approved language
- Read `strategy/competitive/` for competitive context and differentiation angles
- For changelogs: check `git log`, recent PRs, and `specs/` for feature context
- For technical content: read relevant source code and architecture docs

**Never create content without reading the messaging guide first** — consistency across all content is the primary value of having strategy docs.

### 2. Content Type Templates

**Social Media Posts**

Generate multiple variants per message. Adapt for each platform:

```markdown
## Social Media: [Topic]

**Source**: [What strategy doc or product change this is based on]
**Key Message**: [From messaging hierarchy]
**CTA**: [What we want people to do]

### LinkedIn (Professional, longer-form)
[2-3 paragraphs with line breaks for readability]
[Include a question or insight to drive engagement]
[CTA]

### Twitter/X (Concise, punchy)
[Thread format if needed]
1/ [Hook — the most interesting thing]
2/ [Context — why it matters]
3/ [Proof point or example]
4/ [CTA with link]

### Twitter/X (Single tweet variant)
[Under 280 chars, self-contained]

### Hacker News (Technical, understated)
[Title: descriptive, not marketing-speak]
[Comment: technical context, honest about trade-offs, invite feedback]

### Reddit (Community-appropriate, helpful)
[Subreddit-specific framing]
[Focus on solving a problem, not promoting]
```

**Blog Post Outline**
```markdown
# Blog: [Working Title]

**Target Audience**: [Who this is for]
**Pillar Theme**: [From content pyramid]
**Goal**: [What the reader should think/do after reading]
**SEO Target**: [Primary keyword if applicable]

## Outline

### Hook
[Opening that creates interest — stat, question, or relatable problem]

### Problem
[The challenge the reader faces — use their language]

### Our Approach
[How we think about solving this — not a product pitch, a perspective]

### Implementation / How-To
[Concrete, actionable content — code examples, steps, architecture]

### Results / Evidence
[Data, testimonials, benchmarks, or before/after]

### CTA
[What to do next — try it, read more, join community]

## Key Points to Include
- [ ] [Point 1 with source/evidence]
- [ ] [Point 2]
- [ ] [Point 3]
```

**Changelog / Release Announcement**
```markdown
# Changelog: [Version/Date]

## What's New

### [Feature Name]
[One sentence: what it does and why it matters to the user]

[2-3 sentences: how it works, what problem it solves]

**Example/Screenshot**: [if applicable]

### [Feature Name]
...

## Improvements
- [Improvement] — [brief user-facing impact]

## Fixes
- [Fix] — [what was broken and is now working]
```

**Product Launch Copy**
```markdown
# Launch: [Feature/Product Name]

## Headline Options
1. [Benefit-focused headline]
2. [Problem-focused headline]
3. [Curiosity-focused headline]

## Subheadline
[Expands on headline with specifics]

## Hero Section
[2-3 sentences that capture the value proposition]

## Key Benefits (3-4)
### [Benefit 1]
[Short description with proof point]

### [Benefit 2]
...

## Social Proof
[Testimonial, metric, or credibility signal]

## CTA
**Primary**: [Main action — "Start free", "Try it now"]
**Secondary**: [Alternative — "See documentation", "Watch demo"]

## Email Announcement
**Subject line options**:
1. [Option 1]
2. [Option 2]

**Body**:
[Email draft]
```

**Developer Content (Diataxis Framework)**

Identify which type is needed:
- **Tutorial**: Learning-oriented, "follow along to build X"
- **How-to Guide**: Task-oriented, "how to accomplish X"
- **Explanation**: Understanding-oriented, "why X works this way"
- **Reference**: Information-oriented, "complete API for X"

### 3. Content Atomization

When given a single source (strategy doc, feature spec, blog post), break it into multiple pieces:

```
Source Document
├── Blog post (long-form)
├── LinkedIn post (professional insight)
├── Twitter thread (key takeaways)
├── Single tweet (best soundbite)
├── HN submission (technical angle)
├── Email snippet (for newsletter)
└── Internal announcement (for team)
```

### 4. Competitive Differentiation in Content

When creating content that touches on competitive topics:

1. Read competitor profiles from `strategy/competitive/competitors/`
2. Identify our differentiation angle from `strategy/marketing/positioning.md`
3. Use "positive positioning" — lead with our strengths, don't attack competitors
4. Address competitor strengths honestly when doing comparison content
5. Use the approved language from messaging guide

### 5. Output

Save drafts to `strategy/content/drafts/[YYYY-MM-DD]-[topic].md`
Save reusable templates to `strategy/content/templates/`

### 6. Review Checklist

Before presenting drafts:
- [ ] Consistent with messaging guide voice and tone
- [ ] Uses approved language (not banned terms)
- [ ] Differentiators are evidence-backed
- [ ] CTA is clear and appropriate for the channel
- [ ] Platform-specific formatting (LinkedIn vs Twitter vs HN)
- [ ] No unverified competitive claims
- [ ] Technical content is accurate (verified against source code)
- [ ] Date-stamped if referencing competitor data

## Quality Standards

- **Strategy-first** — Every piece of content should trace back to a positioning decision or messaging theme
- **Platform-native** — LinkedIn post should not read like a tweet; HN submission should not read like marketing
- **Draft quality** — Aim for 70-80% ready. The human adds brand taste, humor, and final polish
- **Multiple variants** — Always provide 2-3 options for headlines, hooks, and CTAs
- **Honest and specific** — "Reduces setup time from 2 hours to 2 minutes" beats "Saves you time"
- **Audience-aware** — Developer content should be technical; executive content should focus on outcomes
