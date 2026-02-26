# Blog Content Authoring Guide

This guide is for AI agents (and humans) writing blog posts for the SAM developer blog. Follow these conventions to produce content that is consistent, discoverable, and genuinely useful to developers.

## File Location & Naming

- Blog posts live in `apps/www/src/content/blog/`
- Use kebab-case slugs: `building-warm-node-pooling.md`
- The filename (minus `.md`) becomes the URL slug: `/blog/building-warm-node-pooling/`
- Do NOT include dates in filenames — the date goes in frontmatter

## Frontmatter Format

Every post must start with a YAML frontmatter block:

```yaml
---
title: "Your Post Title Here"
date: 2026-02-25
author: Author Name
category: engineering
tags: ["cloudflare-workers", "durable-objects", "performance"]
excerpt: "One or two sentences that appear on the blog index card and in meta description tags. Keep under 160 characters."
---
```

### Required fields

| Field | Description |
|-------|-------------|
| `title` | Post title. Under 60 characters for SEO. Put the primary keyword near the start. |
| `date` | Publication date in `YYYY-MM-DD` format. |
| `author` | Author name as it should appear on the post. |
| `category` | Exactly one of: `announcement`, `engineering`, `tutorial`, `devlog` |
| `tags` | YAML array of tags. Use existing tags when possible (see below). |
| `excerpt` | 1-2 sentences for the blog index card and `<meta description>`. Under 160 characters. |

### Optional fields

| Field | Description |
|-------|-------------|
| `draft` | Set to `true` to exclude from the published blog. Defaults to `false`. |

### Categories

| Category | When to use |
|----------|-------------|
| `announcement` | Product launches, major milestones, new features |
| `engineering` | Architecture decisions, deep dives, how-we-built-X |
| `tutorial` | Step-by-step guides, how-to content |
| `devlog` | Building-in-public updates, war stories, lessons learned |

### Common tags

Use these existing tags before inventing new ones:

`cloudflare-workers`, `durable-objects`, `d1`, `hetzner`, `go`, `typescript`, `websockets`, `devcontainers`, `security`, `performance`, `ux`, `ai-agents`, `claude-code`, `open-source`, `architecture`, `pulumi`, `github-app`, `jwt`

If you need a new tag, use lowercase kebab-case.

## Writing Style

### Voice & Tone

- **Conversational but precise.** Write like you're explaining something to a smart colleague, not presenting at a conference.
- **First person plural** ("we") for team decisions. First person singular ("I") is fine for personal narratives in devlog posts.
- **Opinionated.** Take a position. "We chose X because Y" is better than "X and Z are both options."
- **Specific.** Use concrete numbers, code snippets, and examples. "12-second cold start" beats "dramatically faster."

### Structure

1. **Lead with the TL;DR.** The first paragraph should tell the reader what the post is about and why they should care. Don't bury the lede.
2. **One idea per section.** Use `##` headings to break the post into scannable sections. Each section should make one point.
3. **Code examples early.** If the post is technical, show code within the first few scroll-lengths. Developers skim for code blocks.
4. **End with what's next.** Close with next steps, open questions, or a call to action — not a summary of what was already said.

### The 80/20 Rule

80% of content should be genuinely educational — useful even if the reader never uses SAM. 20% can be product-specific. A post about "Durable Objects as Per-Tenant Databases" should teach DO patterns that work anywhere, with SAM as the example. This builds trust and SEO authority.

### Formatting Conventions

- **Headings**: Use `##` for main sections, `###` for subsections. Never use `#` (the title comes from frontmatter).
- **Code blocks**: Always specify the language for syntax highlighting (` ```typescript `, ` ```go `, ` ```yaml `, etc.).
- **Inline code**: Use backticks for function names, file paths, env vars, CLI commands (`getPostBySlug()`, `apps/www/src/`, `NODE_WARM_TIMEOUT_MS`, `pnpm build`).
- **Bold**: Use for key terms on first introduction or emphasis. Don't overuse.
- **Links**: Link to source code, docs, ADRs, and specs when referencing them. Use relative links for internal content, absolute URLs for external.
- **Lists**: Use bullet lists for unordered items, numbered lists for sequences/steps.
- **Tables**: Use for structured comparisons (e.g., "Option A vs Option B").
- **Blockquotes**: Use for callouts, important notes, or quoting external sources.

## Content Quality Checklist

Before publishing, verify:

- [ ] Title is under 60 characters and includes the primary keyword
- [ ] Excerpt is under 160 characters and compelling
- [ ] Post has a clear thesis or takeaway in the first paragraph
- [ ] All code blocks have language annotations
- [ ] No `#` headings (title comes from frontmatter)
- [ ] Links are not broken
- [ ] Technical claims are accurate — verify against the actual codebase
- [ ] The post is useful to someone who doesn't use SAM (80/20 rule)
- [ ] Author name is correct

## Content Ideas & Source Material

The project history is rich with content. When looking for topics:

- **Git log**: 497+ commits across 30 days of development
- **Pull requests**: 191+ merged PRs, many with detailed descriptions
- **Feature specs**: `specs/` directory contains 22 feature specifications with architecture decisions
- **ADRs**: `docs/adr/` contains Architecture Decision Records with context and tradeoffs
- **Task files**: `tasks/` contains implementation notes and retrospectives

### High-Priority Topics

These topics have strong source material and broad developer appeal:

1. **Hybrid D1 + Durable Objects storage** — ADR 004, spec 018
2. **WebSocket reconnection hardening** — 15+ PRs fixing real-time issues
3. **BYOC security model** — `docs/architecture/credential-security.md`
4. **Chat-first UX simplification** — Spec 022, collapsing 7 tabs to 1
5. **Warm node pooling** — Spec 021, three-layer orphan defense
6. **PTY multiplexing in Go** — Spec 012, `packages/vm-agent/`
7. **Autonomous task execution** — Spec 021, spec 022

## Technical Accuracy

- **Always verify claims against the codebase.** Read the relevant source files before writing about how something works.
- **Reference specific files.** Instead of "our encryption module," say "the `encryptCredential()` function in `apps/api/src/lib/credentials.ts`."
- **Include real code, not pseudocode.** If showing how something works, extract from the actual implementation. Simplify if needed, but note what was simplified.
- **Check the constitution.** The project constitution is at `.specify/memory/constitution.md`. Ensure blog content doesn't contradict project principles.

## SEO Considerations

- **Title**: Primary keyword near the start. Under 60 chars.
- **Excerpt**: Doubles as meta description. Under 160 chars. Include a secondary keyword.
- **Headings**: Use headings that could be search queries ("How warm node pooling works" not "Implementation details").
- **Internal links**: Link to other blog posts when relevant. Vary anchor text.
- **Structured content**: Use headings, lists, tables, and code blocks. AI-driven search engines (Google AI Overviews, Perplexity, ChatGPT) favor well-structured, comprehensive content over thin pages.

## Process

1. Write the post as a `.md` file in `apps/www/src/content/blog/`
2. Preview locally with `pnpm --filter @simple-agent-manager/www dev` and navigate to `/blog/`
3. Run `pnpm --filter @simple-agent-manager/www build` to verify no build issues
4. Commit and push on a feature branch
5. Open a PR for review
