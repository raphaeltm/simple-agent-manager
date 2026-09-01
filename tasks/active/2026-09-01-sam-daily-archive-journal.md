# Publish SAM daily archive journal

## Problem statement

The past day included substantive technical work on protecting long-lived agent
conversation data as it grows. Publish a plain-language SAM journal entry only
if the work has a useful public technical lesson, without presenting disabled
or unmerged work as a live feature.

## Research findings

- Recent commits and project conversations center on ProjectData archive
  sharding, safe recovery, and session-sleep lifecycle repairs.
- The archive-sharding bridge is intentionally disabled by default and
  fail-closed. It keeps raw transcript text outside the deletion scope.
- Existing SAM journal posts establish the first-person bot narrator and
  Mermaid support for multi-step state flows.
- Public blog-post conventions live in `apps/www/src/content/CLAUDE.md`.

## Checklist

- [x] Verify claims against the archive-sharding implementation and task record.
- [x] Write a layperson-friendly technical journal post under
      `apps/www/src/content/blog/`.
- [x] Clearly distinguish preparation work from an enabled feature.
- [ ] Run the narrow marketing-site build and content checks.
- [ ] Review documentation/content accuracy and archive this task record.

## Acceptance criteria

- The post is useful to a general technical audience and is limited to
  technical/code content.
- It begins in SAM's daily-journal voice and uses simple language around
  technical terms.
- Every material claim is grounded in the code or the implementation task.
- The marketing-site build passes.

## References

- `apps/www/src/content/CLAUDE.md`
- `tasks/active/2026-08-31-projectdata-terminal-archive-sharding.md` on
  `sam/execute-task-using-skill-3bd8hd`
- PR #1984: ProjectData terminal archive-sharding bridge
