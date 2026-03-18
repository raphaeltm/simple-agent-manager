# SAM Aspirational Style Guide

> *"I can't carry it for you, but I can carry you."* — Samwise Gamgee

**Last Updated**: 2026-03-17
**Update Trigger**: Brand direction change, major UI redesign, or new product surface

---

## 1. Brand Identity

### The Story

SAM is Samwise Gamgee for developers. Not the hero of the story — the one who makes the hero's journey possible. Frodo carries the Ring; Sam carries Frodo. Your developers carry the vision; SAM carries the infrastructure, the provisioning, the agent orchestration, the tedious setup — so they can focus on building.

This isn't just a name. It's a design philosophy: **invisible reliability with a warm heart.**

### Brand Pillars

| Pillar | LOTR Metaphor | What It Means |
|--------|---------------|---------------|
| **Reliability** | Sam never abandons the quest | Your agents run. Your VMs provision. Your code ships. Every time. |
| **Simplicity** | The Shire — no unnecessary complexity | Clean interfaces, clear language, no enterprise bloat |
| **Warmth** | Fireside comfort after a long journey | Developer tools don't have to be cold. Personality in copy, delight in interactions |
| **Power** | Mithril — lightweight but impossibly strong | Simple surface, massive capability underneath |
| **Fellowship** | The journey is better together | Multi-agent, multi-cloud, collaborative by nature |

### Brand Voice

**Tone**: Friendly expert. Like a senior engineer who's genuinely happy to help — knows everything, explains clearly, never condescends.

**Do**:
- Use active, specific verbs: "Provision a VM" not "Get started with infrastructure"
- Include personality in empty states and micro-copy
- Reference the journey metaphor naturally: quests, paths, fellowship
- Be technically precise — developers smell BS instantly
- Use humor sparingly but with conviction

**Don't**:
- Use corporate jargon: "leverage," "synergize," "best-in-class"
- Oversell — let the product speak
- Force LOTR references where they don't fit naturally
- Talk down to users — they know what a container is

**Voice Examples**:

| Context | Before (Current) | After (Aspirational) |
|---------|-------------------|----------------------|
| Empty dashboard | "No active tasks" | "The Shire is quiet. No quests in progress." |
| Task submitted | "Task created" | "Quest accepted. Sam's packing the supplies." |
| VM provisioning | "Creating node..." | "Forging your workspace..." |
| Task complete | "Task completed successfully" | "Quest complete. The code is deployed." |
| Error state | "An error occurred" | "We've hit a snag on the road. Here's what happened:" |
| Warm pool ready | "Warm node available" | "A pony's saddled and waiting." |

---

## 2. Color System — "The Palette of Middle-earth"

### Design Philosophy

The color system draws from the landscapes of Middle-earth, grounded in nature but with the precision of Elvish craftsmanship. Dark backgrounds evoke starlit nights in the wild; accent colors reference specific realms and materials.

### Primary Palette

#### Backgrounds — "The Night Sky Over the Shire"

| Token | Hex | Name | Use |
|-------|-----|------|-----|
| `--shire-night` | `#0a0f0e` | Deepest canvas | Page background, the infinite dark |
| `--shire-earth` | `#111a17` | Surface | Cards, panels, elevated content |
| `--shire-moss` | `#1a2b26` | Interactive surface | Hover states, active backgrounds |
| `--shire-stone` | `#0d1512` | Inset | Input fields, recessed areas |

#### Text — "Starlight and Moonlight"

| Token | Hex | Name | Use |
|-------|-----|------|-----|
| `--starlight` | `#e8f0ec` | Primary text | Headlines, body copy, high emphasis |
| `--moonlight` | `#a3b5ad` | Secondary text | Descriptions, metadata, muted content |
| `--twilight` | `#6b7f77` | Tertiary text | Placeholders, disabled states |

#### Accents — "The Realms"

| Token | Hex | Realm | Use |
|-------|-----|-------|-----|
| `--shire-green` | `#22c55e` | The Shire | Primary action, success, growth, the core brand color |
| `--shire-green-dim` | `#16a34a` | The Shire (deeper) | Hover states, visited actions |
| `--rivendell-gold` | `#f0c674` | Rivendell | Warnings, premium features, highlights, wisdom |
| `--mithril-silver` | `#c0caf5` | Moria/Dwarves | Code text, terminal output, information |
| `--mordor-red` | `#f7768e` | Mordor | Errors, destructive actions, danger |
| `--lorien-teal` | `#34d399` | Lothlórien | Focus rings, selection, magical interactions |
| `--gandalf-purple` | `#bb9af7` | Wizards | AI/agent indicators, processing states |
| `--rohan-amber` | `#e0af68` | Rohan | Pending states, in-progress, attention needed |

#### Borders — "The Paths Between"

| Token | Hex | Name | Use |
|-------|-----|------|-----|
| `--path-default` | `#253530` | Default border | Subtle separation |
| `--path-strong` | `#344a42` | Strong border | Active/focused element borders |

### Extended Palette — Agent Colors

Each supported agent gets a realm-inspired color identity:

| Agent | Color | Hex | LOTR Mapping |
|-------|-------|-----|--------------|
| Claude Code | Gandalf Purple | `#bb9af7` | The wizard — wise, powerful, guides the quest |
| OpenAI Codex | Mithril Silver | `#7aa2f7` | Dwarven craft — precise, engineered, reliable |
| Gemini CLI | Rivendell Gold | `#f0c674` | Elven knowledge — vast context, ancient wisdom |
| Mistral Vibe | Rohan Amber | `#ff9e64` | Riders of Rohan — fast, fierce, rides the wind |

### Color Usage Rules

1. **Green is the hero color.** It's the Shire — home base, primary action, success. Use it for CTAs, active states, and confirmations.
2. **Purple marks AI activity.** Whenever an agent is thinking, processing, or generating — purple. It's Gandalf doing magic.
3. **Gold is for highlights and wisdom.** Tooltips, pro tips, featured content, warnings that are more "pay attention" than "danger."
4. **Red is rare and meaningful.** Destructive actions only. The eye of Sauron should not appear casually.
5. **Teal is the guide.** Focus rings, breadcrumbs, selection indicators — it's the light of Galadriel's phial, showing the way.

---

## 3. Typography — "The Scripts of Middle-earth"

### Design Philosophy

Typography should feel like it was crafted, not generated. We want the precision of Elvish script with the readability of modern developer tools. The hierarchy should feel natural — like reading a well-organized grimoire.

### Recommended Font Stack

#### Display & UI: **Geist Sans** (by Vercel)

Why: Purpose-built for developer tools. Swiss precision, high x-height for screen legibility, modern geometric letterforms. Open source (SIL OFL). Used by Vercel, widely adopted in the dev tool ecosystem.

```css
--font-display: 'Geist Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```

#### Code & Terminal: **Geist Mono**

Why: Designed as the monospace companion to Geist Sans. Perfect alignment, clear character distinction (0 vs O, 1 vs l vs I), optimized for code readability.

```css
--font-mono: 'Geist Mono', 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
```

#### Special Display (Optional): **Geist Pixel**

Why: Pixel-art variant of Geist, perfect for easter eggs, loading screens, or retro-themed UI moments. Could be used for LOTR-themed decorative headings or achievement badges.

### Type Scale — "The Hierarchy of the Realm"

| Level | Name | Size | Weight | Line Height | LOTR Name | Use |
|-------|------|------|--------|-------------|-----------|-----|
| 1 | King | 2rem (32px) | 700 | 1.15 | `--type-king` | Hero headlines, landing page titles |
| 2 | Lord | 1.5rem (24px) | 700 | 1.2 | `--type-lord` | Page titles, major section headers |
| 3 | Captain | 1.25rem (20px) | 600 | 1.3 | `--type-captain` | Section headings, card group titles |
| 4 | Ranger | 1rem (16px) | 600 | 1.4 | `--type-ranger` | Card titles, sidebar headings |
| 5 | Hobbit | 0.9375rem (15px) | 400 | 1.5 | `--type-hobbit` | Body text, primary reading |
| 6 | Whisper | 0.8125rem (13px) | 400 | 1.5 | `--type-whisper` | Secondary text, descriptions |
| 7 | Rune | 0.75rem (12px) | 500 | 1.4 | `--type-rune` | Captions, timestamps, badges, labels |

### Typography Rules

1. **Geist Sans for everything above the terminal.** UI, navigation, copy, headings.
2. **Geist Mono for everything in the terminal.** Code blocks, command output, file paths, API responses.
3. **Never mix more than 2 weights in a single component.** Keep it clean.
4. **Use the scale religiously.** No custom font sizes — every text element maps to a named level.
5. **Letter-spacing tightens at large sizes.** King (-0.02em), Lord (-0.015em), body and below (0).

---

## 4. Naming Conventions — "The Fellowship of Features"

### Design Philosophy

LOTR names should feel like delightful discoveries, not forced gimmicks. Use them where they add meaning and memorability — feature names, internal codenames, status labels. Don't rename "Save" to "Forge" if it confuses users.

### Feature Naming Map

| Feature | Current Name | LOTR Name | Rationale |
|---------|-------------|-----------|-----------|
| Task execution | Tasks | **Quests** | A task is a quest — you describe the goal, an agent embarks on it |
| Warm node pool | Warm Pool | **The Prancing Pony** | Warm nodes are like the inn — ready and waiting for the next traveler |
| Workspace | Workspace | **Workshop** or **Forge** | Where the work happens — Elven smithies, Dwarven forges |
| Project | Project | **Realm** | A project is a domain — a realm of code with its own governance |
| Chat session | Session | **Council** | Like the Council of Elrond — you discuss, plan, and decide |
| Agent | Agent | **Companion** | Agents are companions on the quest — each with unique abilities |
| Node (VM) | Node | **Outpost** | Physical infrastructure in the wild — a base of operations |
| Dashboard | Dashboard | **The Map** | Overview of all realms and active quests |
| Settings | Settings | **The Archives** | Where configuration and credentials are kept |
| Command Palette | Command Palette | **The Palantír** | You gaze into it to see across the entire realm |
| Notifications | Notifications | **Ravens** | Messages that arrive from afar |

### Status Labels

| Status | Current | LOTR Variant | Color |
|--------|---------|-------------|-------|
| Pending | pending | `awaiting` | `--rohan-amber` |
| Creating/Provisioning | creating | `forging` | `--gandalf-purple` |
| Running | running | `on the road` | `--shire-green` |
| Completed | completed | `quest complete` | `--shire-green` |
| Failed | failed | `fallen` | `--mordor-red` |
| Stopped | stopped | `resting` | `--moonlight` |
| Warm (pooled) | warm | `saddled` | `--rohan-amber` |

### Naming Rules

1. **User-facing labels use LOTR names only where intuitive.** "Quests" is clear; "Palantír" needs a tooltip.
2. **Internal/API names stay technical.** The API endpoint is `/tasks`, not `/quests`. LOTR names are a UI/brand layer.
3. **Tooltips bridge the gap.** Hover over "The Prancing Pony" → "Warm node pool: pre-provisioned VMs ready for instant use"
4. **Don't rename standard actions.** "Save", "Delete", "Cancel" stay as-is. Nobody wants to figure out what "Unmake" means.
5. **Use LOTR names for delight moments.** Loading screens, empty states, achievement badges, changelogs — places where personality shines.

---

## 5. Component Patterns — "The Artifacts"

### Buttons — "Actions of the Fellowship"

```
Primary (Shire Green):    Solid green background, white text — for quests (primary actions)
Secondary (Shire Earth):  Dark surface with border — for supporting actions
Danger (Mordor Red):      Red background — for destructive/irreversible actions
Ghost (Transparent):      Text-only with hover state — for tertiary actions
Magic (Gandalf Purple):   Purple gradient — for AI-powered actions (new!)
```

**The "Magic" button variant**: A new button type specifically for AI-triggered actions. When you click "Start Quest" (submit a task to an agent), the button should have a purple shimmer — Gandalf is doing his thing. This distinguishes human actions (green) from AI actions (purple).

### Cards — "Scrolls and Tomes"

Cards are the primary content container. They should feel like well-crafted scrolls — clean edges, clear hierarchy, purposeful.

**Card Anatomy**:
```
┌─────────────────────────────────┐
│ ● Status dot    Card Title   ⋯  │  ← Header: status + title + overflow menu
│─────────────────────────────────│
│                                 │
│  Body content with clear        │  ← Body: primary information
│  hierarchy and breathing room   │
│                                 │
│─────────────────────────────────│
│  Metadata · Timestamp · Agent   │  ← Footer: secondary info, muted text
└─────────────────────────────────┘
```

**Card States**:
- Default: `--shire-earth` background, `--path-default` border
- Hover: `--shire-moss` background, subtle lift shadow
- Active/Selected: `--shire-green` left border accent (2px)
- Error: `--mordor-red` left border accent, tinted background

### The Agent Avatar System

Each agent gets a distinctive avatar — not a generic robot icon, but a character-inspired visual identity:

| Agent | Avatar Concept | Visual |
|-------|---------------|--------|
| Claude Code | Gandalf-inspired | Staff/hat silhouette in purple on dark circle |
| OpenAI Codex | Dwarven-inspired | Anvil/hammer silhouette in blue on dark circle |
| Gemini CLI | Elven-inspired | Star/leaf silhouette in gold on dark circle |
| Mistral Vibe | Rohirrim-inspired | Horse/wind silhouette in amber on dark circle |

### Loading States — "The Journey"

Loading states are personality opportunities. Instead of generic spinners:

- **VM Provisioning**: Animated path being drawn (like a route on a map), with milestone dots
- **Agent Thinking**: Pulsing purple glow (Gandalf's staff charging)
- **Task Queue**: Hobbits walking animation (simple silhouette, 3-frame loop)
- **Page Load**: "Consulting the map..." or "Lighting the beacons..." with a subtle shimmer

### Empty States — "The Quiet Shire"

Empty states should be warm and guiding, not cold and blank:

```
┌─────────────────────────────────┐
│                                 │
│         🌿                      │
│   The Shire is quiet.           │
│   No quests in progress.        │
│                                 │
│   [Start a Quest]               │
│                                 │
│   Your companions are ready     │
│   and the road awaits.          │
│                                 │
└─────────────────────────────────┘
```

### Notifications — "The Ravens"

Notification types with LOTR personality:

| Type | Icon | Copy Pattern |
|------|------|-------------|
| Task Complete | Green checkmark | "Quest complete: {title}" |
| Needs Input | Gold alert | "A decision awaits in {project}" |
| Error | Red flame | "Trouble on the road: {error}" |
| PR Created | Purple merge | "A gift from your companion: PR #{number}" |
| Progress | Teal pulse | "Your companion reports from the field" |

---

## 6. Micro-Interactions & Animation — "Magic"

### Design Philosophy

Animations should feel like magic — purposeful, elegant, never gratuitous. Every animation should communicate something: confirmation, transition, progress, or delight.

### Motion Principles

1. **Fast by default.** 150ms for state changes, 250ms for entrances, 350ms for complex transitions. Developers hate waiting.
2. **Ease-out for entrances.** Content should decelerate into position (arriving, landing).
3. **Ease-in for exits.** Content should accelerate away (departing, dismissing).
4. **Spring for delight.** Subtle overshoot on success states — the satisfaction of a quest completed.
5. **No motion when working.** When the user is typing, coding, or reading — zero animations. They're in flow.

### Signature Animations

| Interaction | Animation | Duration | Feeling |
|-------------|-----------|----------|---------|
| Task submitted | Green pulse ripple outward from button | 400ms | "Quest accepted!" |
| Agent processing | Purple shimmer along card edge | Continuous | "Magic at work" |
| VM provisioned | Forge glow → solid green | 600ms | "Your workshop is ready" |
| Quest complete | Confetti particles (green + gold, subtle) | 800ms | "Victory!" |
| Error | Red pulse, single shake | 300ms | "Something's wrong" |
| Navigation transition | Crossfade with 16px vertical slide | 200ms | Smooth journey |

### The "Beacons" System

When significant events happen across the app (task complete, VM ready, error), light a "beacon" — a brief colored glow at the top of the viewport that fades in 2 seconds. Like the beacons of Gondor, it draws attention without interrupting.

- Green beacon: Success events
- Purple beacon: AI completion events
- Gold beacon: Attention needed
- Red beacon: Error events

---

## 7. Landing Page — "The Map of the Realm"

### Hero Section Redesign

The landing page should feel like unrolling a map of Middle-earth — discovering the possibilities ahead.

**Headline Options** (test these):
1. *"Your AI agents need a Samwise."* — Direct LOTR reference, positions SAM as the support character
2. *"Launch AI coding agents. SAM handles the rest."* — Clear value prop with name emphasis
3. *"Every quest needs a Sam."* — Short, memorable, emotional

**Sub-headline**: *"Provision cloud VMs, orchestrate AI agents, and ship code — all from a chat interface. Bring your own cloud. Keep your keys. Pay your provider."*

### Visual Direction

The landing page hero should feature a **stylized topographic/fantasy map** aesthetic:
- Dark background with subtle contour lines (like a terrain map)
- Key features positioned as "locations" on the map
- Animated paths connecting them (data flow visualization)
- The SAM logo as a compass rose

### Section Flow

1. **Hero** — The quest begins (headline + CTA + agent avatars)
2. **The Companions** — Agent showcase with personality (character cards, not feature grids)
3. **The Journey** — How it works as a path/timeline (visual flow, not numbered steps)
4. **The Forge** — Technical depth (architecture, BYOC, security)
5. **The Fellowship** — Social proof, community, open source
6. **The Road Ahead** — Roadmap as a journey map
7. **Begin Your Quest** — Final CTA

---

## 8. Logo Evolution

### Current Logo

Geometric code chevron (`</>` implied) in green on dark background. Clean and functional but generic — could be any dev tool.

### Aspirational Direction

The logo should evolve to incorporate subtle LOTR symbolism while remaining recognizably "dev":

**Concept: "The Green Door"**

Bilbo's round green door is the beginning of every adventure. The logo could be:
- A stylized round door shape (circle) with a terminal cursor blinking inside
- Green (#22c55e) on dark (#0a0f0e)
- The door slightly ajar — adventure awaits
- Clean enough to work at 16px favicon size

**Concept: "The Compass"**

SAM guides you through the journey:
- Four-pointed star (Elvish star of the Dúnedain) with a cursor/chevron integrated
- Can encode the `>_` terminal prompt into one of the star points
- Works as both app icon and favicon

**Concept: "The Leaf"**

The Lórien leaf brooch — given to the Fellowship as protection:
- Stylized leaf shape with a circuit/code pattern in the veining
- Green gradient from `--shire-green` to `--lorien-teal`
- Organic but geometric — nature meets technology
- Pins well as a badge, scales well as favicon

### Logo Rules

1. **Always on dark backgrounds.** The brand is dark-first.
2. **Minimum clear space**: 1x the logo height on all sides.
3. **Never stretch, rotate, or recolor** outside the approved palette.
4. **Monochrome variant**: White for use on colored backgrounds.

---

## 9. Iconography

### Icon Style

Use **Lucide React** (current choice) as the base icon set — it's open source, consistent, and developer-friendly. Extend with custom icons for LOTR-specific concepts.

### Custom Icon Concepts

| Concept | Description | Use |
|---------|-------------|-----|
| Quest Scroll | Rolled parchment with checkmark | Task/quest indicators |
| Forge Anvil | Anvil with spark | VM provisioning |
| Compass Rose | Four-pointed star | Navigation, command palette |
| Raven | Simplified bird silhouette | Notifications |
| Phial | Galadriel's light | Focus/search indicator |
| Fellowship Ring | Interlocked circle | Multi-agent/collaboration |
| Map Pin | Flag/pin on terrain | Node/location indicator |

---

## 10. Implementation Roadmap

This style guide is aspirational — here's how to implement it incrementally:

### Phase 1: Foundation (Quick Wins)
- [ ] Install Geist Sans + Geist Mono fonts
- [ ] Update CSS custom properties with LOTR-named color tokens (alias existing values initially)
- [ ] Add personality to empty states and micro-copy
- [ ] Create the "Magic" button variant (purple, for AI actions)
- [ ] Update loading state copy ("Forging your workspace...")

### Phase 2: Identity
- [ ] Design and implement new logo concepts (test 2-3 options)
- [ ] Create agent avatar system (character-inspired icons)
- [ ] Implement the Beacon notification system
- [ ] Add LOTR naming layer to UI labels (with tooltips for clarity)
- [ ] Redesign landing page hero with map aesthetic

### Phase 3: Polish
- [ ] Implement signature animations (quest submitted, agent processing, etc.)
- [ ] Create custom icon set for LOTR-specific concepts
- [ ] Add Geist Pixel for easter eggs and achievement badges
- [ ] Implement the full landing page redesign
- [ ] Create brand assets pack (social cards, open graph images, favicons)

### Phase 4: Delight
- [ ] Achievement/milestone system ("You've completed 100 quests!")
- [ ] Seasonal themes (Yule/winter theme, Spring/Shire theme)
- [ ] Interactive quest timeline for task history
- [ ] Agent personality in chat responses (distinct voice per agent-character)
- [ ] Sound design (optional, toggleable): subtle audio cues for events

---

## 11. Competitive Differentiation

### What Other Dev Tools Do

| Tool | Brand Personality | Visual Identity |
|------|-------------------|-----------------|
| **Vercel** | Premium minimalist | Black/white, Geist font, Swiss precision |
| **Linear** | Opinionated craftsman | Purple gradients, clean motion, changelog personality |
| **Supabase** | Authentic open-source friend | Green, approachable, meme-friendly |
| **Railway** | Modern infrastructure | Dark with neon accents, glassmorphism |
| **Warp** | Power user tool | Purple/blue, tech-forward, dense UI |
| **Cursor** | Apple-polished AI | Pastels, blur effects, consumer-friendly |

### SAM's Unique Position

**None of them have narrative.** They have aesthetics, but no story. SAM has something none of them can replicate: a beloved character identity that developers already know and love.

Samwise Gamgee is:
- The most relatable character in LOTR (ordinary person doing extraordinary things)
- The actual hero of the story (Tolkien said so himself)
- A symbol of loyalty, perseverance, and humble competence

This maps perfectly to what a developer tool should be: **not the hero (that's the developer), but the one who makes the hero's success possible.**

### The SAM Brand Promise

*"You focus on the quest. SAM handles the journey."*

---

## 12. Design Tokens Reference (CSS Custom Properties)

```css
/* === SAM Aspirational Design Tokens === */

/* Backgrounds — The Night Sky Over the Shire */
--sam-bg-canvas: #0a0f0e;
--sam-bg-surface: #111a17;
--sam-bg-surface-hover: #1a2b26;
--sam-bg-inset: #0d1512;

/* Text — Starlight and Moonlight */
--sam-text-primary: #e8f0ec;
--sam-text-secondary: #a3b5ad;
--sam-text-tertiary: #6b7f77;
--sam-text-on-accent: #ffffff;

/* Accents — The Realms */
--sam-color-shire-green: #22c55e;
--sam-color-shire-green-dim: #16a34a;
--sam-color-rivendell-gold: #f0c674;
--sam-color-mithril-silver: #c0caf5;
--sam-color-mordor-red: #f7768e;
--sam-color-lorien-teal: #34d399;
--sam-color-gandalf-purple: #bb9af7;
--sam-color-rohan-amber: #e0af68;

/* Semantic Aliases */
--sam-color-accent: var(--sam-color-shire-green);
--sam-color-success: var(--sam-color-shire-green);
--sam-color-warning: var(--sam-color-rivendell-gold);
--sam-color-danger: var(--sam-color-mordor-red);
--sam-color-info: var(--sam-color-mithril-silver);
--sam-color-focus: var(--sam-color-lorien-teal);
--sam-color-ai: var(--sam-color-gandalf-purple);

/* Borders — The Paths Between */
--sam-border-default: #253530;
--sam-border-strong: #344a42;

/* Typography */
--sam-font-display: 'Geist Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
--sam-font-mono: 'Geist Mono', 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;

/* Type Scale */
--sam-type-king: 2rem;
--sam-type-lord: 1.5rem;
--sam-type-captain: 1.25rem;
--sam-type-ranger: 1rem;
--sam-type-hobbit: 0.9375rem;
--sam-type-whisper: 0.8125rem;
--sam-type-rune: 0.75rem;

/* Spacing (8pt grid) */
--sam-space-1: 4px;
--sam-space-2: 8px;
--sam-space-3: 12px;
--sam-space-4: 16px;
--sam-space-5: 20px;
--sam-space-6: 24px;
--sam-space-8: 32px;
--sam-space-10: 40px;
--sam-space-12: 48px;
--sam-space-16: 64px;

/* Border Radius */
--sam-radius-sm: 6px;
--sam-radius-md: 10px;
--sam-radius-lg: 14px;
--sam-radius-full: 9999px;

/* Shadows (Dark-tuned) */
--sam-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.25);
--sam-shadow-md: 0 4px 8px rgba(0, 0, 0, 0.3);
--sam-shadow-lg: 0 12px 24px rgba(0, 0, 0, 0.35);
--sam-shadow-glow-green: 0 0 20px rgba(34, 197, 94, 0.15);
--sam-shadow-glow-purple: 0 0 20px rgba(187, 154, 247, 0.15);
--sam-shadow-glow-gold: 0 0 20px rgba(240, 198, 116, 0.15);

/* Motion */
--sam-duration-fast: 150ms;
--sam-duration-normal: 250ms;
--sam-duration-slow: 350ms;
--sam-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--sam-ease-in: cubic-bezier(0.7, 0, 0.84, 0);
--sam-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);

/* Z-Index */
--sam-z-sticky: 10;
--sam-z-dropdown: 20;
--sam-z-drawer: 40;
--sam-z-dialog: 50;
--sam-z-palantir: 60;
--sam-z-beacon: 70;
--sam-z-toast: 9999;
```

---

## Research Sources

- [Evil Martians: "We studied 100 dev tool landing pages"](https://evilmartians.com/chronicles/we-studied-100-devtool-landing-pages-here-is-what-actually-works-in-2025)
- [Vercel Geist Design System](https://vercel.com/geist/introduction)
- [Vercel Geist Font](https://vercel.com/font)
- [Inside Supabase's Breakout Growth](https://www.craftventures.com/articles/inside-supabase-breakout-growth)
- [Developer Marketing Best Practices 2026](https://www.strategicnerds.com/blog/developer-marketing-best-practices-2026)
- [Developer Marketing: What Works in 2025](https://www.carilu.com/p/developer-marketing-in-2025-what)
- [The hidden logic of Thiel's LOTR-inspired company names](https://qz.com/1346926/the-hidden-logic-of-peter-thiels-lord-of-the-rings-inspired-company-names)
- [What can we learn about naming from LOTR](https://www.northboundbrand.com/insights/naming-and-lord-of-the-rings)
- [Dark Mode Color Palettes 2025](https://colorhero.io/blog/dark-mode-color-palettes-2025)
- [Mastering UI/UX Design for Developers 2026](https://dev.to/del_rosario/mastering-ui-ux-design-for-developers-in-2026-1p18)
- [10 UX Design Shifts for 2026](https://uxdesign.cc/10-ux-design-shifts-you-cant-ignore-in-2026-8f0da1c6741d)
