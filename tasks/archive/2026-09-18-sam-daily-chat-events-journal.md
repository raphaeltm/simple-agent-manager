# Publish SAM's daily journal about readable agent work

## Problem

The last day produced two related changes that are useful to explain publicly: chat now groups consecutive agent tool calls into an expandable activity card, and session events are easier to find and understand. The public site needs a short daily journal in SAM's own voice that makes both changes understandable to someone who has never used or architected SAM.

## Research findings

- PR #2096 groups consecutive tool-call timeline items in `apps/web/src/components/project-message-view/tool-call-groups.ts`. The card keeps detailed per-tool output available on expansion and its state survives virtualized scrolling. The post must explain both the readability gain and that details remain accessible.
- PR #2098 improves the project Events page with named empty states, semantic status colors, visible section counts, and a 30-second refresh for schedules. The post must describe states plainly and avoid implying that every background record means a task executed.
- PR #2099 adds the existing session-scoped event views to an Events tool in the chat tool rail. The post must distinguish the compact in-chat view from the full Events page.
- The blog guide at `apps/www/src/content/CLAUDE.md` requires accurate claims, SAM frontmatter, a short title/excerpt, and a useful technical takeaway. This daily journal must use first-person SAM language and contain no business or strategy material.

## Implementation checklist

- [x] Write a SAM-authored devlog in `apps/www/src/content/blog/` with valid frontmatter and the required journal introduction.
- [x] Explain expandable tool activity cards in plain language, including why detailed tool output remains available.
- [x] Explain session-scoped event views, clear statuses, and schedule refresh without overstating execution guarantees.
- [x] Include a Mermaid diagram because it clarifies the compact-to-detail interaction model.
- [x] Link to public chat documentation and the implementing pull requests.
- [x] Run focused marketing-site validation: lint, typecheck, tests, build, link checks, and the Mermaid browser check at desktop and mobile viewports.
- [x] Run the task-completion and documentation synchronization reviews before archiving this task.

## Acceptance criteria

- A reader new to SAM can understand what a tool call is, why cards are grouped, and how to view individual details.
- A reader new to SAM can understand the difference between event history for one conversation and the full project view.
- The post uses the exact SAM journal framing requested by the user and contains only technical and product behavior.
- The marketing site builds, passes focused checks, and renders the Mermaid diagram if one is included.

## References

- PR #2096 — grouped tool-call activity cards
- PR #2098 — Events page polish
- PR #2099 — session Events drawer
- `apps/www/src/content/CLAUDE.md`
