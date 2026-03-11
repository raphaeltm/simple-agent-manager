---
name: marketing-strategy
description: "Marketing strategy and positioning. Builds positioning documents, messaging guides, content calendars, channel strategy, and gap analyses. Use when defining positioning, planning content, crafting messaging, or identifying marketing gaps."
---

# Marketing Strategy

Develop and maintain marketing strategy artifacts — positioning, messaging, content planning, and channel strategy.

## When to Use

- Defining or refining product positioning
- Creating a messaging guide or voice/tone guidelines
- Planning content calendar for a quarter
- Analyzing marketing gaps vs competitors
- Building channel strategy (where to reach audience)
- Auditing current messaging for consistency

## Workflow

### 1. Understand Current State

Before creating any artifact, check what already exists:
- Read `strategy/competitive/` for competitor research (required input)
- Read `strategy/marketing/` for existing marketing docs
- Read `strategy/business/` for business context (target market, pricing)
- Read the project's current website copy, README, and any public-facing content

### 2. Frameworks

**STP (Segmentation, Targeting, Positioning)**
1. **Segment** the market by meaningful dimensions (company size, use case, technical sophistication, buying motivation)
2. **Target** the segments with highest fit (value alignment, ability to serve, market size)
3. **Position** with a clear statement:

```markdown
## Positioning Statement

For [target audience]
who [situation/need],
[Product] is a [category]
that [key benefit].
Unlike [primary alternative],
we [key differentiator].
```

**RACE Framework (Reach, Act, Convert, Engage)**
Audit content and channels against each funnel stage:

```markdown
| Stage   | Goal | Current Channels | Gap |
|---------|------|-----------------|-----|
| Reach   | Awareness | [what exists] | [what's missing] |
| Act     | Interaction | ... | ... |
| Convert | Trial/signup | ... | ... |
| Engage  | Retention | ... | ... |
```

**Content Strategy Pyramid**
```markdown
## Content Pyramid

### Strategic Narrative (Top)
[The big story — why this category matters, what's changing]

### Pillar Themes (Middle)
1. [Theme 1] — [what it covers, why it matters to audience]
2. [Theme 2]
3. [Theme 3]

### Content Pieces (Base)
[Individual posts, articles, tutorials mapped to pillars]
```

**Message-Market Fit Canvas**
```markdown
| Segment | Pain Point | Our Message | Proof Point | Channel |
|---------|-----------|-------------|-------------|---------|
| DevOps teams | VM management overhead | "Ephemeral by default" | [metric/testimonial] | HN, Reddit |
```

### 3. Output Artifacts

**Positioning Document** → `strategy/marketing/positioning.md`
```markdown
# Positioning

**Last Updated**: YYYY-MM-DD
**Update Trigger**: New market segment entry or major product launch

## Target Audience
[Primary and secondary segments with descriptions]

## Category
[What category we compete in — and whether we want to create/redefine one]

## Positioning Statement
[The formal statement from STP framework above]

## Key Differentiators
1. [Differentiator] — [why it matters to target]
2. ...

## Proof Points
[Evidence that supports each differentiator]

## Competitive Positioning
[How we position against top 3 alternatives — reference competitive research]
```

**Messaging Guide** → `strategy/marketing/messaging-guide.md`
```markdown
# Messaging Guide

**Last Updated**: YYYY-MM-DD

## Voice & Tone
[How we sound — adjectives, examples, do/don't]

## Messaging Hierarchy
### Primary Message
[The one thing we want everyone to remember]

### Supporting Messages
1. [Message] — [when to use it, for which audience]
2. ...

## Approved Language
| Use | Don't Use | Why |
|-----|-----------|-----|
| "ephemeral environments" | "temporary VMs" | [reason] |

## Boilerplate
### One-liner
[Single sentence description]

### Elevator pitch (30 seconds)
[Short paragraph]

### Full description (website/about)
[2-3 paragraphs]
```

**Content Calendar** → `strategy/marketing/content-calendar.md`
**Channel Strategy** → `strategy/marketing/channel-strategy.md`
**Gap Analysis** → inline in positioning or as separate analysis

### 4. Gap Analysis Process

Compare our current marketing presence against competitors:

1. **Channel coverage** — Where are competitors active that we aren't?
2. **Content topics** — What subjects do competitors cover that we don't?
3. **Messaging angles** — What positioning claims are competitors making that we should counter?
4. **SEO/keyword gaps** — What terms do competitors rank for that we don't target?
5. **Social proof** — Where do competitors have testimonials/case studies that we lack?

Produce a prioritized list of gaps with estimated effort and impact.

### 5. Cross-Reference

After producing marketing artifacts:
- Check consistency with `strategy/business/` (pricing, target market alignment)
- Check competitive claims against `strategy/competitive/` (verify accuracy)
- Feed content themes to `/content-create` skill for execution
- Flag engineering implications (features needed for marketing claims)

## Quality Standards

- **Ground positioning in evidence** — Every differentiator needs a proof point
- **Be specific, not generic** — "We reduce environment setup from 2 hours to 2 minutes" beats "We save time"
- **Acknowledge trade-offs** — If we optimize for simplicity, say we're not for complex enterprise workflows
- **Date all competitive claims** — Competitor positioning changes; date your comparisons
- **Test messaging with real language** — Use customer/prospect phrasing from reviews and conversations, not marketing jargon
