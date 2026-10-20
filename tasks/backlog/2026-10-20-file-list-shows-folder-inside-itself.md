# A sub-folder's file listing includes the folder itself

## Problem

Opening a sub-folder in the chat Files panel lists that folder as an entry inside itself. Listing
`sub` returns `sub` (a directory) and then its real contents.

`handleFileList` (`packages/vm-agent/internal/server/files.go`) runs
`find <dirPath> -maxdepth 1 -not -name . -printf '%y\t%s\t%T@\t%f\n'`. For the root (`.`), the
start point is filtered out by `-not -name .`. For any other path the start point is printed too,
with `%f` = its own name, and `parseFileListOutput` only skips `.` and `..`. The panel
(`apps/web/src/components/chat/ChatFilePanel.tsx`) shows the entries as returned, so clicking the
self-entry navigates to `sub/sub`, which does not exist.

## Context

- Found on 2026-10-20 while testing working-tree confinement for teammates (PR #2383). Reproduced
  with real `find`: `find sub -maxdepth 1 -not -name . -printf '%y\t%f\n'` prints `d sub` then
  `f ok.txt`.
- Pre-existing for owners. The confined (teammate) path deliberately returns exactly the owner's
  listing, so `TestConfinedReadsServeTheWorkingTree` compares the two rather than pinning the
  self-entry.

## Acceptance Criteria

- [ ] Listing a sub-folder returns only its children (for example `-mindepth 1` in the `find`
      call), for both the owner's and a teammate's requests, on both runtimes.
- [ ] A Go test lists a sub-folder through the real handler and asserts the folder is not among its
      own entries; it fails before the fix.
- [ ] The workspace page's file browser, which calls the agent directly, is checked for the same
      symptom.
