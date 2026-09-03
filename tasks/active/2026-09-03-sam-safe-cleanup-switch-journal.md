# Publish SAM journal on controlled ProjectData cleanup

## Problem statement

Review the prior 24 hours of SAM commits and task conversations. If there is a
useful public technical story, publish a SAM-authored daily journal post in
plain language. The current code has a distinct follow-up to the 2026-09-02
journal: tool-payload cleanup now has an index-seekable cursor, daily automatic
cadence, and one bounded, audited manual pass for a single project. The post
must explain that change without treating internal operator controls as a
general-user feature or repeating yesterday's explanation of the unsafe query.

## Research findings

- Blog conventions and the public content checklist are in
  `apps/www/src/content/CLAUDE.md`; posts belong in
  `apps/www/src/content/blog/`.
- The 2026-09-02 post `sams-journal-when-cleanup-made-more-work.md` covered the
  decision to stop a non-seekable cleanup query. Today's post must cover the
  completed follow-up: PR #2005 made the cursor index-friendly, and PR #2008
  added safe, superadmin-only per-project manual cleanup controls.
- `tool-payload-cleanup-candidates.ts` now uses a row-value cursor over
  `(session_id, created_at, sequence, id)`, allowing SQLite to seek on the
  indexed `(session_id, created_at, sequence)` prefix instead of repeatedly
  deriving a complex `OR` predicate.
- `tool-payload-manual-cleanup.ts` reuses the regular archival cleanup path,
  but requires a reason and idempotency key, persists the starting marker and
  cooldown before work starts, enforces configured row/byte/time limits, and
  returns measurement and termination information.
- `tool-payload-archive.ts` writes and records the R2 archive before replacing
  inline tool payload content; an R2 or bookkeeping error fails closed and
  leaves the original inline data intact.
- The manual route is superadmin-only and project-scoped. It is an emergency
  operator control, not a product button for ordinary users.
- The current task conversations corroborate that manual cleanup was proven as
  a bounded pass even when automatic cleanup was disabled, and that its
  idempotency and cooldown behaviour were deliberate safeguards.
- A Mermaid diagram will make the boundary between the operator request,
  ProjectData SQLite database, R2 archive, and measurement record easy to
  follow for readers new to SAM.

## Implementation checklist

- [x] Draft a new SAM journal entry in first-person bot voice.
- [x] Explain ProjectData, the cursor, archive-before-strip, and the manual
      safety guards in simple language.
- [x] Include only verified technical facts from the source and conversations.
- [x] Add a Mermaid diagram of the controlled cleanup flow.
- [x] Compare the draft against the 2026-09-02 journal to avoid duplicate
      claims and keep the scope distinct.
- [x] Run the marketing-site lint, typecheck, build, and link checker.
- [x] Validate the final Markdown frontmatter, prose, Mermaid fence, and
      rendered output.
- [ ] Complete documentation and task-completion review before creating a PR.

## Acceptance criteria

- [x] A new file in `apps/www/src/content/blog/` has valid frontmatter,
      `author: SAM`, and an excerpt under 160 characters.
- [x] The opening identifies SAM as a bot keeping a daily journal and the post
      discusses only technology, code, and features.
- [x] Readers without knowledge of SAM can understand why a database cleanup
      needs a route, limits, a cooldown, and an archive-before-change rule.
- [x] Technical statements are supported by the current source code and do not
      claim that a failed archive can remove inline data.
- [x] A Mermaid diagram materially clarifies the multi-system cleanup flow.
- [x] Narrow marketing-site checks and content validation pass.
- [ ] The post is submitted, reviewed through the required automated gates,
      merged, and its production deployment is monitored.

## References

- `apps/www/src/content/CLAUDE.md`
- `apps/www/src/content/blog/sams-journal-when-cleanup-made-more-work.md`
- `apps/api/src/durable-objects/project-data/tool-payload-cleanup-candidates.ts`
- `apps/api/src/durable-objects/project-data/tool-payload-manual-cleanup.ts`
- `apps/api/src/durable-objects/project-data/tool-payload-archive.ts`
- `apps/api/src/routes/admin/project-data-storage.ts`
- PR #2005 and PR #2008
