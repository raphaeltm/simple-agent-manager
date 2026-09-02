# Publish SAM journal on safe background maintenance

## Problem statement

Review the last 24 hours of SAM commits and project conversations. If they
contain a useful public technical story, publish a SAM-authored daily journal
entry in plain language. The post must cover only verified code, features, and
engineering work; it must not repeat the prior archive-sharding journal as if
that disabled work were already enabled.

## Research findings

- The existing journal format lives in `apps/www/src/content/blog/`; the public
  authoring guide is `apps/www/src/content/CLAUDE.md`.
- The prior 2026-09-01 journal explained the intentionally disabled
  archive-sharding bridge. It is preparation work, not the subject of this
  entry.
- PR #2002 (`ce1ec87c`) changed the ProjectData event-log cleanup code defaults
  from default-on with a 60-second recheck to opt-in with an hourly recheck.
  Explicit deployment configuration can override those defaults, so this is a
  safer baseline rather than a claim that every existing alarm changed itself.
- PR #2004 (`3c998826`) disabled the production tool-payload cleanup switch
  while its candidate query is redesigned. The query repeatedly scanned the
  hot ProjectData SQLite database rather than using an efficient seek.
- Current project sessions confirm that the immediate goal is to remove that
  scan pressure; the follow-up work is still being tested, so this post must
  not claim it has shipped.
- A Mermaid flowchart will help explain the difference between the ordinary
  alarm path, an over-frequent maintenance path, and the safer temporary
  configuration.

## Implementation checklist

- [x] Inspect commits, code paths, and relevant conversation evidence.
- [x] Compare the topic with the previous daily journal to avoid duplication.
- [x] Draft a public, layperson-friendly SAM journal post.
- [x] Use a Mermaid diagram to clarify the maintenance flow.
- [x] Run narrow marketing-site validation and content checks.
- [x] Complete documentation and task-completion review, then archive this
      record.

## Acceptance criteria

- The entry appears in `apps/www/src/content/blog/` with valid frontmatter and
  `author: SAM`.
- It begins in SAM's daily-journal bot voice and discusses only technical code
  work from the last day.
- It explains the Durable Object and background cleanup with simple language
  while retaining accurate terms where they help.
- It distinguishes a shipped safety switch from the planned query redesign and
  the separately disabled archive-sharding rollout.
- The www build and relevant content checks pass.
- The pull request is self-merged only after the repository's automated and
  review gates complete.

## Validation

- `pnpm --filter @simple-agent-manager/www lint` passed.
- `pnpm --filter @simple-agent-manager/www typecheck` passed with four
  pre-existing baseline Astro-template errors reported by the checker.
- `pnpm --filter @simple-agent-manager/www build` passed and generated the
  new journal route.
- `pnpm --filter @simple-agent-manager/www check:links` passed with zero broken
  internal documentation links.
- Static content checks passed: required frontmatter, title/excerpt limits,
  balanced code fences, one Mermaid diagram, no body H1, and `git diff --check`.
- Task-completion review passed for the committed content; the expected PR and
  merge criterion remains pending until Phase 7.
- Documentation review found and corrected the task-record distinction between
  code defaults and explicit deployment configuration; no public-post issue
  remains.

## References

- `apps/www/src/content/CLAUDE.md`
- `apps/www/src/content/blog/sams-journal-making-room-for-old-conversations.md`
- PR #2002 / `ce1ec87c`
- PR #2004 / `3c998826`
- `apps/api/src/durable-objects/project-data/storage-safety.ts`
- `apps/api/src/durable-objects/project-data/tool-payload-cleanup-candidates.ts`
