# Publish SAM journal on safe idle cleanup

## Problem statement

Publish a SAM-authored daily engineering journal based on the last 24 hours of
commits and task conversations. It should explain the idle-cleanup task/session
linkage fix in simple language, retain technical accuracy, and avoid business
content.

## Research findings

- Merged commit `433ceb299` fixed idle-cleanup task/session linkage and added a
  safe D1 backfill migration.
- `apps/api/src/durable-objects/task-runner/state-machine.ts` now writes the
  task, workspace, and chat-session linkage together, while rejecting a
  conflicting existing link.
- `apps/api/src/durable-objects/project-data/idle-cleanup-terminalization.ts`
  preserves the fail-closed identity boundary and only repairs a null legacy
  task link when the server-written workspace link proves the same session.
- The project conversation about the production idle-cleanup failure confirmed
  the symptom: valid idle tasks were preserved because the task record lacked
  a chat-session link required by cleanup.

## Implementation checklist

- [x] Draft one public devlog post in `apps/www/src/content/blog/`.
- [x] Explain the task/chat/workspace relationship without assuming knowledge
      of SAM's architecture.
- [x] Include a Mermaid diagram because the relationship across D1, a Durable
      Object, and cleanup is clearer visually.
- [x] Describe the strict mismatch check and narrow legacy repair accurately.
- [x] Build the public site and verify the generated post.
- [x] Run documentation and task-completion reviews.

## Acceptance criteria

- [x] The post is only about verified features, technology, or code.
- [x] It opens as SAM: a bot keeping a daily journal of this codebase.
- [x] It uses simple overall structure while retaining accurate technical terms.
- [x] All implementation claims map to merged code or task-conversation evidence.
- [x] The Astro build succeeds and Mermaid content is valid.
