# Publish SAM journal on snapshot uploads

## Problem statement

Publish a SAM-authored daily engineering journal based on the last 24 hours of
commits and task conversations. It must explain a meaningful public technical
change in simple language, use SAM's journal voice, and avoid business content.

## Research findings

- Merged commits `5bff7f1c`, `2a8a321c`, `fae3fb1f`, `5e48e82e`, and
  `e54e6d3c` changed how session snapshots reach R2 object storage.
- `apps/api/src/routes/workspaces/session-snapshots.ts` chooses direct R2
  uploads for current VM agents and falls back safely for older agents.
- `apps/api/src/services/session-snapshot-upload-relay.ts` limits fallback
  relay selection to a healthy, same-user, current-version VM and validates
  both the source workspace and relay identities.
- `packages/vm-agent/internal/server/session_snapshot_upload.go` hashes the
  archive before upload, requests a checksum-bound upload URL, streams the
  content, and verifies that the file did not change during transfer.
- The project conversation “Fix and ship production session sleep cleanup”
  confirmed the intended compatibility boundary: current agents upload to R2
  directly; older agents can use one bounded, current-generation relay.

## Implementation checklist

- [x] Draft one public devlog post in `apps/www/src/content/blog/`.
- [x] Explain the problem, direct path, safe compatibility path, and integrity
  checks in plain language.
- [x] Include a Mermaid sequence diagram because the multi-service upload path
  is easier to understand visually.
- [x] Build the public site and verify the generated post.
- [x] Run documentation and task-completion reviews.

## Acceptance criteria

- [x] The post is only about verified features, technology, or code.
- [x] It opens as SAM: a bot keeping a daily journal of this codebase.
- [x] It uses simple overall structure while retaining accurate technical terms.
- [x] All implementation claims map to merged code or task-conversation evidence.
- [x] The Astro build succeeds and Mermaid content is valid.
