# Strategy

Strategic planning artifacts for SAM. Each subdirectory covers a domain with living documents that are updated as conditions change.

## Directory Structure

```
strategy/
├── competitive/          # Competitor research and market landscape
│   ├── landscape.md      # Market overview, categories, trends
│   ├── feature-matrix.md # Feature comparison grid (maintained)
│   ├── positioning-map.md# Visual positioning on key dimensions
│   └── competitors/      # Individual competitor profiles
├── business/             # Business model, pricing, GTM
│   ├── market-sizing.md  # TAM/SAM/SOM analysis
│   ├── business-model.md # Business Model Canvas
│   ├── pricing.md        # Pricing analysis and strategy
│   └── gtm-plan.md       # Go-to-market plan
├── marketing/            # Positioning, messaging, channels
│   ├── positioning.md    # Core positioning document
│   ├── messaging-guide.md# Voice, tone, approved language
│   ├── content-calendar.md# Quarterly content plan
│   └── channel-strategy.md# Channel selection and approach
├── engineering/          # Roadmap, tech radar, build-vs-buy
│   ├── roadmap.md        # Now/Next/Later priorities
│   ├── tech-radar.md     # Technology assessment radar
│   ├── tech-debt.md      # Prioritized tech debt register
│   └── adr/              # Architecture Decision Records
└── content/              # Content creation workspace
    ├── ideas.md          # Content topic pipeline with angles and code refs
    ├── templates/        # Reusable content templates
    └── drafts/           # Work-in-progress content
```

## How Domains Chain Together

```
Competitive Research ──► Marketing Strategy ──► Content Creation
       │                        │                      ▲
       │                        ▼                      │
       └───────────────► Business Strategy              │
                                │                      │
                                ▼                      │
                         Engineering Strategy ─────────┘
```

1. **Competitive research** produces profiles, feature matrices, positioning maps
2. **Business strategy** uses market data to size opportunity, set pricing, plan GTM
3. **Marketing strategy** uses positioning + business goals to create messaging framework
4. **Engineering strategy** uses competitive gaps + business priorities to set roadmap
5. **Content creation** draws from all four domains for consistency

## Document Maintenance

Every document should specify its **update trigger** — the event that means it needs review:

| Document | Update Trigger |
|----------|---------------|
| Feature matrix | Competitor ships a notable feature |
| Pricing analysis | Quarterly, or competitor pricing change |
| Positioning doc | New market segment or major product launch |
| Roadmap | Planning cycle boundaries |
| Competitor profiles | Quarterly, or major competitor news |

## Available Skills

Use these Claude Code skills to work with strategy documents:

- `/competitive-research` — Build competitor profiles, feature matrices, SWOT analyses
- `/marketing-strategy` — Positioning, messaging guides, gap analysis, channel strategy
- `/business-strategy` — Market sizing, business model canvas, pricing, GTM planning
- `/engineering-strategy` — Roadmaps, tech radar, build-vs-buy, tech debt tracking
- `/content-create` — Draft social posts, blog outlines, changelogs, launch copy from strategy docs
