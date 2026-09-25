# Preserve transcript messages across pagination and reporter payload limits

## Problem

Timestamp-only cursors omit tied messages at a page boundary. VM reporter payload fallback can discard or truncate a message whose serialized JSON exceeds the control-plane limit.

## Research

- Root and archived message reads sort by timestamp and sequence but filter only timestamp; archived chunks also prune equal-timestamp chunks.
- Archive copy already uses `(created_at, sequence, id)` as its seek key.
- REST `before`/`after` accept numeric timestamps, so retain numeric semantics and add exact tuple cursors for callers that page.
- Worker `readRequestBodyWithLimit` checks bytes of the full serialized JSON, default 262144; individual content and upload parts are separately limited to 102400 UTF-8 bytes.
- Reporter outbox is SQLite and ordered by monotonic ID. Existing size fallback can replace content or metadata with markers and delete it, which is not lossless.
- September 25 reconciliation marks both issues open; current main still contains both paths.

## Checklist

- [x] Reproduce live and archived boundary loss and reporter data loss through read/delivery triggers.
- [x] Add total-order cursor support to root and compact archive reads; update paginating clients while retaining numeric timestamp API semantics.
- [x] Add one-row outbox delivery of multiple small messages and one oversized message through private bounded parts plus verified canonical commit; retain the original on failed upload.
- [x] Test serialization bytes, non-ASCII, exact-page ties, forward/reverse pagination, overlap/retry, and archive boundary.
- [x] Prove guards discriminate by surgical revert (root omitted tied rows; archive returned 9996/10000; reporter sent 768155 bytes and retained a rejected row).
- [ ] Run targeted and full checks, independent reviews, staging VM validation, PR review, merge, and production monitoring.

First independent review rejected a fragment-row approach because no reader reassembled it. That implementation has been replaced by a dedicated upload path that writes exactly one original transcript row. Re-review and staging remain gates.

The second review found interrupted-upload quarantine and old-session outbox issues. The upload path now enforces per-session and project-wide byte/part caps, exposes superadmin-only paginated inventory and exact hashed readback, and marks incomplete parts abandoned after terminal archive grace without presenting them as persisted messages. A real archive sweep passed through source deletion, archived transcript reads, and root quarantine readback. The old-session outbox change was reverted because the callback API rejects writes after relink; that pre-existing lifecycle has a separate backlog record. Reporter `204` responses do not acknowledge persistence. Go, API Worker, admin route, root lint/typecheck/test/build, and mobile/desktop Playwright chat audit passed. Staging, PR review, merge, and production monitoring remain open.

## Acceptance

No persisted transcript row is skipped or duplicated solely because of a tie at a page boundary. Reporter delivery never represents a truncated marker as full content and never deletes unsent bytes after a size rejection. Request bodies stay within the configured limit. Retries are idempotent.
