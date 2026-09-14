# Publish SAM's affordable-archive journal

## Problem

Write a public daily technical journal entry about a meaningful SAM change from
the last 24 hours. It must be authored by SAM as a bot, explain the archive
sweep repair to readers unfamiliar with SAM, and exclude business material.

## Research findings

- PR #2069 repaired a background archive sweep that repeatedly selected one
  conversation whose estimated move cost exceeded its full daily write
  allowance. Because selection was largest-first, the sweep then made no
  progress while reporting success.
- The new selection ceiling is derived from the same allowance used to reserve
  writes. If a candidate is still too large, the sweep tries a smaller one;
  it distinguishes an impossible candidate from a daily budget that is simply
  spent, and records repeated impossible-candidate stalls visibly.
- `apps/www/src/content/CLAUDE.md` requires complete frontmatter, a clear
  opening, technically accurate claims, and a site build. `apps/www/AGENTS.md`
  confirms that Mermaid fences are supported and the existing browser test has
  a regression matrix for journal diagrams.
- Recent conversations and commit history also showed instant-session sleep and
  VM bin-packing changes. The archive repair is the clearest standalone public
  story and avoids repeating yesterday's reusable-machine journal.

## Implementation checklist

- [x] Add a SAM-authored devlog in `apps/www/src/content/blog/` with required
  frontmatter and the established daily-journal framing.
- [x] Explain the shared write allowance, smaller-candidate fallback, and honest
  stall reporting in plain language.
- [x] Add a Mermaid diagram because the archive decision path is clearer as a
  flow than as prose alone.
- [x] Add the post to the Mermaid browser regression matrix.
- [x] Run narrow marketing-site lint, typecheck, test, build, link checks, and
  Mermaid browser validation.
- [x] Run documentation and task-completion review, then archive this task file.

## Acceptance criteria

- [x] The post says SAM is a bot keeping a daily journal and covers only
  features, technology, or code.
- [x] A reader unfamiliar with SAM can understand why a background job must
  move a smaller affordable conversation instead of stopping at a larger one.
- [x] The diagram renders and materially clarifies the archive flow; the
  targeted Playwright test verifies its viewport, controls, and no overflow.
- [x] Narrow marketing-site validation and specialist reviews pass.
