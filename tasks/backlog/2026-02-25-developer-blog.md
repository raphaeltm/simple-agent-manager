# Developer Blog for SAM

**Created**: 2026-02-25
**Status**: Backlog
**Priority**: Medium
**Scope**: Research + implementation planning for a developer blog

---

## Goal

Add a public-facing developer blog to the SAM website that serves as both a content marketing channel and a technical resource for developers building with AI agents, Cloudflare Workers, and cloud infrastructure.

---

## Part 1: Blog Best Practices & Architecture Decisions

### Content Structure & Organization

- **Categories** (primary taxonomy): Architecture, Tutorials, Building-in-Public, How-We-Built-X, AI & Agents, Infrastructure
- **Tags** (secondary taxonomy): cloudflare-workers, durable-objects, go, websockets, devcontainers, security, ux, performance
- **Series support**: Group related posts (e.g., "Building an AI Agent Platform" series)
- **Content types**: Long-form technical posts, changelog/release notes, tutorials, war stories, retrospectives

### URL Structure

```
/blog                          -> Blog index (paginated)
/blog/{slug}                   -> Individual post
/blog/category/{category}      -> Category filter
/blog/tag/{tag}                -> Tag filter
/blog/series/{series-slug}     -> Series page
/blog/rss.xml                  -> RSS feed
```

All URLs should be at `app.${BASE_DOMAIN}/blog/...` as a public (unauthenticated) route.

### SEO Checklist

- [ ] Semantic HTML (`<article>`, `<header>`, `<time>`, `<nav>`)
- [ ] Open Graph meta tags (title, description, image, type)
- [ ] Twitter Card meta tags
- [ ] Structured data (JSON-LD `BlogPosting` schema)
- [ ] Canonical URLs on every page
- [ ] XML sitemap including blog posts
- [ ] RSS feed (Atom or RSS 2.0)
- [ ] `<meta name="description">` unique per post
- [ ] Clean URL slugs (no dates in URLs -- use `/blog/slug` not `/blog/2026/02/slug`)
- [ ] Auto-generated table of contents for posts >1000 words (jump links become rich snippets in Google)
- [ ] Internal linking between related posts
- [ ] Image alt text on all images
- [ ] `loading="lazy"` on below-fold images, explicit dimensions to prevent CLS
- [ ] AVIF/WebP with JPEG fallback via `<picture>` element

### Browsability & Navigation

- **Blog index**: Card grid with title, excerpt, date, category badge, estimated read time
- **Pagination**: Traditional pagination (not infinite scroll) for SEO crawlability
- **Category/tag filtering**: Client-side filtering on index, dedicated routes for each
- **Search**: Consider a simple client-side search (Fuse.js or similar) over post metadata
- **Related posts**: Show 2-3 related posts at the bottom of each post (same category or overlapping tags)
- **Table of contents**: Sticky/floating TOC for long posts, auto-generated from headings
- **Reading progress**: Optional progress bar for long-form posts
- **Series navigation**: Previous/next post links for series content

### Technical Implementation Decision

**Recommendation: Separate Astro site vs in-app React route**

Two viable options:

| Factor | Astro (separate site) | React route (in-app) |
|--------|----------------------|---------------------|
| Performance | Zero JS by default, ~40% faster FCP | Bundles React runtime (~87KB min) |
| SEO | Perfect Core Web Vitals out of box | Requires SSR/prerendering setup |
| Build speed | ~3x faster for content sites | Shares main app build |
| Content authoring | Native MDX, Content Collections API | Needs react-markdown (already installed) |
| Hosting cost | Static files, very cheap | Same as app |
| Complexity | Separate deploy pipeline | Shares existing infra |
| Reuse | Can use React components via islands | Full access to app components |

**Recommended approach**: Start with an in-app React route using the existing `react-markdown` + `remark-gfm` + `prism-react-renderer` stack (all already installed). Blog posts as MDX/markdown files in the repo. This avoids a second build pipeline and leverages the existing design system. Migrate to Astro later if performance or scale demands it.

**Existing dependencies that support this (already in `apps/web/package.json`)**:
- `react-markdown@10.1.0`
- `remark-gfm@4.0.1`
- `prism-react-renderer@2.4.1`
- `lucide-react` (icons)
- `@simple-agent-manager/ui` (design system components)

### Content Authoring Format

Blog posts as markdown/MDX files in the repository:

```
apps/web/src/content/blog/
  {slug}.md         -> Markdown with frontmatter
```

Frontmatter schema:
```yaml
---
title: "Post Title"
slug: "post-title"
date: "2026-02-25"
author: "Author Name"
category: "architecture"
tags: ["cloudflare-workers", "durable-objects"]
series: "building-an-ai-agent-platform"  # optional
seriesOrder: 1                            # optional
excerpt: "A brief description for cards and meta tags"
image: "/blog/images/post-title-hero.webp"  # optional OG image
draft: false
---
```

### Changelog Integration

Follow the Linear model -- changelogs as a growth/marketing tool:

- Maintain a `/blog/changelog` route that aggregates release notes
- Each significant release gets a changelog entry (can be shorter than a full blog post)
- Use benefit-driven language ("Your dashboard now loads 2x faster") not commit-log language
- Include GIFs/screenshots for visual changes
- Link to full blog posts for deep-dive explanations

### Image Strategy

- Store originals in `apps/web/public/blog/images/` as high-quality JPEG/PNG
- Use `<picture>` with AVIF > WebP > JPEG fallback
- Lazy load below-fold images with `loading="lazy"`
- Always set explicit `width` and `height` to prevent CLS
- Consider Cloudflare Images or R2 + Image Resizing for on-the-fly optimization later

---

## Part 2: Content Ideas from Project History

Based on analysis of 497 commits, 191+ merged PRs, 22 feature specs, and 5 ADRs.

### Tier 1: Highest Impact (Publish First)

#### "497 Commits in 30 Days: Building an AI Agent Platform from Scratch"
- **Category**: Building-in-public
- **Audience**: Indie hackers, startup engineers, AI enthusiasts
- **Hook**: The entire project timeline, velocity with AI-assisted development, spec-driven approach
- **Source material**: Full git log, specs/, tasks/

#### "From 7 Tabs to 1 Chat Box: How We Radically Simplified Our UX"
- **Category**: Building-in-public, product design
- **Audience**: Product engineers, UX designers
- **Hook**: Collapsed 7 tabs to a single chat interface; "users think 'I have a repo, go do something' not 'let me manage task states'"
- **Source material**: Spec 022, spec 019, PR #189

#### "Why We Use Both D1 and Durable Objects (and When You Should Too)"
- **Category**: Architecture deep-dive
- **Audience**: Cloudflare Workers developers, serverless architects
- **Hook**: Hybrid storage pattern, single-writer bottleneck, per-tenant DOs with embedded SQLite
- **Source material**: ADR 004, project-first-research.md, spec 018

#### "Building a Browser-Based AI Agent Chat with ACP, Go, and WebSockets"
- **Category**: How-we-built-X
- **Audience**: AI tooling developers, Go developers
- **Hook**: ACP protocol, streaming agent responses, multi-agent support
- **Source material**: Spec 007, packages/vm-agent/internal/acp/, PR #184

### Tier 2: Strong Technical Depth

#### "WebSocket Reconnection Done Right: Lessons from 15 Bug Fixes"
- **Category**: Tutorial / war story
- **Audience**: Frontend engineers, real-time app developers
- **Hook**: 15+ PRs fixing WebSocket issues; progressive hardening from mobile reconnect to replay buffers
- **Source material**: PRs #59, #67, #78, #97, #124, #133, #138, #170, #188

#### "The BYOC Security Model: Why We Never Touch Your Cloud Credentials"
- **Category**: Security deep-dive
- **Audience**: Security engineers, platform builders
- **Hook**: Bring-Your-Own-Cloud, AES-256-GCM encryption, user credentials vs platform secrets
- **Source material**: docs/architecture/credential-security.md, secrets-taxonomy.md

#### "Autonomous Task Execution: From Chat Message to Running Agent in 60 Seconds"
- **Category**: How-we-built-X
- **Audience**: AI platform builders
- **Hook**: Full task flow, warm node pooling, three-layer orphan defense
- **Source material**: Spec 021, spec 022, PRs #184, #186

#### "PTY Multiplexing in Go: Terminal Sessions That Survive Page Refresh"
- **Category**: How-we-built-X
- **Audience**: Go developers, terminal builders
- **Hook**: PTY allocation, ring buffer replay, orphan detection, pure-Go SQLite
- **Source material**: Spec 012, packages/vm-agent/internal/pty/

### Tier 3: Evergreen Tutorials (Long-Tail SEO)

#### "Durable Objects as Per-Tenant Databases: A Practical Guide"
- Tutorial for Cloudflare developers on multi-tenant DO patterns

#### "GitHub App vs OAuth App: Which One (and Why We Use Both)"
- Integration guide covering dual auth, gh CLI injection, env var naming collisions

#### "JWT Auth Between Cloudflare Workers and Remote VMs via JWKS"
- Security pattern tutorial: Worker signs JWTs, publishes JWKS, VM Agent validates

#### "Cloud-Init on Hetzner: Bootstrapping VMs with Zero Embedded Credentials"
- DevOps tutorial: cloud-init templates, systemd, callback-driven readiness

#### "Pulumi + Cloudflare + Hetzner: Our Entire Infrastructure as TypeScript"
- IaC tutorial: R2-backed state, five-phase deploy pipeline, auto-generated secrets

#### "Multi-Workspace Nodes: Running N Devcontainers on a Single VM"
- Platform engineering: 1:N node-workspace model, volume isolation, port isolation

#### "What It Takes to Run Claude Code in a Remote Devcontainer"
- AI tooling: ACP integration, dual auth (API key vs OAuth), credential injection

#### "Warm Node Pooling: Cutting AI Agent Startup Time from Minutes to Seconds"
- Performance: warm state, NodeLifecycle DO, cost-vs-latency tradeoffs

### Additional Content Ideas

- **"One Worker: API + Reverse Proxy + WebSocket Gateway"** -- How a single Cloudflare Worker handles three roles via host-header routing
- **"Agent-Side Message Persistence: Why the Browser Should Never Own Chat History"** -- Architecture decision for server-side chat persistence
- **"Real-Time Boot Log Streaming: Showing Users What Their VM Is Doing"** -- UX engineering with two reverts before success
- **"The Devcontainer Reliability Saga"** -- War story of bind mounts to named volumes, ownership issues, bootstrap resilience
- **"The WebSocket Bug That Took 15 PRs to Fix"** -- Narrative retelling of progressive WebSocket hardening
- **"From Stateless to Stateful: How Our Architecture Evolved in 30 Days"** -- Three architectural phases: labels+DNS -> D1 -> hybrid D1+DO

---

## Part 3: Exemplary Developer Blogs to Study

| Company | What Makes It Great |
|---------|-------------------|
| **Linear** | Changelogs as growth tool; benefit-driven language; rich GIFs/screenshots; public from day one |
| **Cloudflare** | Deep engineering content; explains how things work under the hood; builds credibility |
| **Vercel** | Clean hierarchy; connects changes to broader context; discoverable across platforms |
| **Raycast** | Community-driven; reads every piece of feedback; API-focused content |
| **WorkOS** | Clarity-first changelogs; no jargon; immediate user comprehension |
| **Mintlify** | Five principles framework: human impact, hierarchy, context, relevance, discoverability |

---

## Part 4: Implementation Checklist

### Phase 1: Foundation
- [ ] Create `apps/web/src/content/blog/` directory for markdown posts
- [ ] Create `BlogLayout.tsx` component (public, no AppShell, no auth required)
- [ ] Add blog routes to `App.tsx` as public routes (`/blog`, `/blog/:slug`)
- [ ] Build `BlogIndex.tsx` page with card grid, category filters, pagination
- [ ] Build `BlogPost.tsx` page with markdown rendering, TOC, meta tags
- [ ] Add frontmatter parsing (gray-matter or similar)
- [ ] Add RSS feed generation
- [ ] Add XML sitemap entries for blog posts

### Phase 2: SEO & Polish
- [ ] Add Open Graph and Twitter Card meta tags (react-helmet or similar)
- [ ] Add JSON-LD structured data for BlogPosting
- [ ] Add auto-generated table of contents from headings
- [ ] Add related posts component
- [ ] Add reading time estimation
- [ ] Add syntax highlighting theme that passes WCAG contrast

### Phase 3: Content
- [ ] Write first 3-4 Tier 1 posts
- [ ] Set up a changelog route/section
- [ ] Establish publishing cadence (weekly or biweekly)

### Phase 4: Growth
- [ ] Add blog link to main navigation (public section)
- [ ] Set up RSS distribution
- [ ] Cross-post strategy (dev.to, Hashnode, HN)
- [ ] Social sharing buttons on posts

---

## Open Questions

- [ ] Separate domain (`blog.simple-agent-manager.org`) vs subdirectory (`app.simple-agent-manager.org/blog`)?
  - Subdirectory is better for SEO (domain authority consolidation)
  - But the app is behind auth -- blog needs a public route
- [ ] Should the blog be a separate Astro site deployed to Cloudflare Pages, or React routes in the existing app?
  - Start with React routes; migrate to Astro if SEO/performance demands it
- [ ] Content review workflow -- who approves posts before publishing?
- [ ] Image hosting -- commit to repo, or use R2/Cloudflare Images?

---

## Notes

- The web app already has `react-markdown`, `remark-gfm`, and `prism-react-renderer` installed -- no new dependencies needed for MVP
- React Router 6 is the routing library; blog would be public routes outside the `ProtectedLayout`
- The existing `@simple-agent-manager/ui` design system provides Card, Button, Tabs, Breadcrumb, and other components that can be reused
- Styling uses CSS custom properties (`--sam-color-*`, `--sam-space-*`, etc.), not Tailwind
