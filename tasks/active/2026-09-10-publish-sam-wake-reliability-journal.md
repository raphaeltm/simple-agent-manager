# Publish SAM's Wake-Reliability Journal

## Problem

The public blog needs a daily technical journal that explains the most useful
merged work from the preceding 24 hours without assuming that readers know
SAM's internal architecture. The September 9 task-start journal already
explains initial runtime selection, so this post focuses on what happens when
an existing sleeping session needs to return.

## Research findings

- PR #2052 fixed a Hetzner 412 placement response being treated as a permanent
  configuration problem. A compute-pool fallback chain can now move to the
  next compatible offering instead of ending at the first temporary placement
  failure.
- PR #2054 replaced a lifetime limit of three session-recovery attempts with a
  decaying, 15-minute burst budget. The prior limit could permanently strand a
  valid saved session after brief provider or DNS trouble. Migration 0155
  restores still-unexpired rows that were blocked by the old counter.
- PR #2055 preserved the runtime-mode value when callers update other workspace
  runtime fields. Before the fix, opening a browser or terminal connection, or
  waking a session, could clear that setting and stop a Cloudflare Container
  agent from receiving its runtime configuration and project environment.
- The relevant task conversations and merged commit descriptions confirm that
  these are reliability and code changes only. The post must avoid business
  claims and distinguish temporary retryable problems from a promise of
  unlimited retries.

## Implementation checklist

- [x] Review the merged commit log and relevant SAM task conversations from the
  preceding 24 hours.
- [x] Write a SAM-authored blog post in `apps/www/src/content/blog/` with the
  required frontmatter and bot-journal opening.
- [x] Explain the recovery budget, fallback placement, and preserved runtime
  setting in plain language while naming the relevant technologies where useful.
- [x] Add a Mermaid diagram for the recovery sequence because several
  components participate in a wake-up.
- [x] Add the post to the Mermaid browser-test matrix.
- [x] Run narrow marketing-site validation, inspect the generated post, and
  record the evidence: lint, build, link checking, 49 unit tests, and 10
  desktop/mobile Mermaid browser checks passed. Astro template validation held
  at its pre-existing baseline of four errors.
- [x] Complete documentation and task-completion validation. The content schema,
  merged PR sources, internal links, generated route, and browser-rendered
  diagram were all checked; no drift or incomplete planned work was found.
- [ ] Open, review, and merge the PR.

## Acceptance criteria

- [x] The post is public technical content only and does not repeat the
  September 9 task-start-journal topic.
- [x] It identifies SAM as a bot keeping a daily journal and uses simple
  language appropriate for readers new to SAM.
- [x] It accurately describes the merged recovery, placement, and runtime
  behavior, with PR sources.
- [x] The Mermaid diagram represents the actual wake-up sequence and renders
  in the site's Markdown pipeline.
- [ ] Narrow marketing-site validation passes and the changes are merged through
  a PR.
