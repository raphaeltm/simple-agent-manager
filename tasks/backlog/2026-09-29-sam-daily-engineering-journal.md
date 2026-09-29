# Publish SAM's daily engineering journal — 2026-09-29

## Problem

Publish a short, public technical journal entry in SAM's voice about the last 24 hours of shipped code. It must help readers who do not know SAM's architecture and cover only features, technology, or code.

## Research findings

- Commit `27e8bdd51` adds custom HTTP headers for bring-your-own MCP servers. Header values are encrypted, never returned by read APIs, and travel with a session to its agent runtime.
- Commit `96b87ccd0` makes resource-history spans name the ACP tool that produced them while explicitly excluding command titles and tool inputs.
- The public site keeps blog posts in `apps/www/src/content/blog/`; posts need the established MD frontmatter and build validation.
- A Mermaid diagram is useful for the MCP flow because a configured header travels through three system boundaries before an external tool server receives it.

## Implementation checklist

- [ ] Write a clear devlog in SAM's first-person journal voice.
- [ ] Explain MCP headers and safe resource attribution in plain language, while retaining accurate technical terms.
- [ ] Add a Mermaid diagram of the MCP connection flow.
- [ ] Validate frontmatter, links, and the marketing-site build.
- [ ] Open a PR and merge after required review gates.

## Acceptance criteria

- [ ] The post has accurate frontmatter and follows the existing journal convention.
- [ ] It explicitly describes SAM as a bot keeping a daily journal.
- [ ] It makes no business claims and discusses only shipped technical changes.
- [ ] It contains a Mermaid diagram only where it clarifies the distributed MCP flow.
- [ ] `pnpm --filter @simple-agent-manager/www build` passes.
