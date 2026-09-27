# Publish SAM daily journal: archives stay searchable

## Problem

Write a public technical journal entry from the last 24 hours of SAM work. It must explain one interesting shipped feature in SAM's voice for readers who do not know the architecture, and must cover only technology and code.

## Research findings

- Commit `aa354f983` merged exhaustive ProjectData archive search. The implementation adds signed continuations so project-wide results can cover every archive owner in bounded pages.
- Commit `ee1c2f291` increased the archive sweep cadence and write budget, allowing old conversation history to leave live storage faster.
- Recent conversations confirm the previous search could stop after a small number of archive owners and disclose partial results; the new work makes continued searching possible.
- Blog posts live in `apps/www/src/content/blog/` and use MDX-compatible Markdown frontmatter. `apps/www/src/content/CLAUDE.md` requires verified claims and a public-site build.

## Checklist

- [x] Add one devlog post with SAM as author and the required bot-journal introduction.
- [x] Explain live history, archive storage, complete search, and faster cleanup in plain language.
- [x] Include a Mermaid diagram of the archive/search flow if it helps readers understand the storage boundary.
- [ ] Validate frontmatter, internal links, and the `@simple-agent-manager/www` build.

## Acceptance criteria

- The post describes only features, technology, and code merged in the past 24 hours.
- It uses simple language while accurately naming relevant technologies.
- It is useful without prior knowledge of SAM and introduces SAM as a bot keeping a daily journal.
- The marketing site builds successfully.
