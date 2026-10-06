---
title: Project Files
description: Browse a project's remote repository by branch and review what an agent changed — a diff against the default branch — without provisioning a workspace.
---

The **Files** tab on a project lets you browse the project's remote git repository and review changes **by branch, without starting a workspace**. It works for both GitHub-connected projects and SAM-native [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) repositories.

## Why it exists

SAM agents do their work on branches (each task pushes to its own output branch). Previously, seeing those files meant provisioning a workspace. The Files tab lets you review an agent's output — **what changed versus the default branch** — instantly, on mobile, with no VM.

This is now the fastest first stop after an agent finishes: open the output branch in **Changes**, decide whether the work is directionally right, then only open a workspace if you need to run commands or make manual edits.

## Two modes

Selecting a branch gives you two views:

- **Changes** (default for any non-default branch): the files changed versus the default branch, each expandable to a diff. This is the fastest way to review what an agent produced. Arriving from a task's branch opens here automatically.
- **Browse**: the full file tree at the selected branch — navigate directories, open any file with syntax highlighting, and search files by name.

On the default branch there are no changes to show, so the view defaults to Browse.

## What you can do

- **Switch branches** — the default branch is listed first; agent output branches are selectable like any other.
- **Review a diff** — per-file additions/deletions and a unified diff, with a "view whole file" jump into Browse.
- **Open files** — text with syntax highlighting, Markdown rendered (with a source toggle), images previewed, and large or binary files offered as a download.
- **Search by name** — fuzzy filename search across the whole tree at the selected branch.
- **Deep-link** — the URL captures the branch, mode, and path, so a link opens exactly the file or diff you were viewing (for anyone with access to the project and its repository).

## Access

Browsing is read-only and requires access to the project. For GitHub-backed projects, access is additionally gated by your own GitHub permission on the repository — the same intersection SAM enforces everywhere, so losing repository access also removes your ability to browse it here.

GitLab-backed project browsing follows the same product model: repository access is user-scoped, and SAM uses the connected user's GitLab authorization rather than borrowing another project member's identity.

## Notes

- Content search across arbitrary branches is not available yet; search matches file **names**.
- Very large diffs or trees may be truncated by the provider; the UI indicates when this happens.
- Artifacts-backed browsing uses a shallow clone performed inside the SAM API Worker; it is gated behind the same `ARTIFACTS_ENABLED` flag as Artifacts project creation.

## Configuration (self-hosting)

| Variable | Default | Purpose |
| --- | --- | --- |
| `REPO_BROWSE_MAX_INLINE_BYTES` | `1000000` | Max bytes to inline as text in the file viewer; larger files stream as a download. |
| `REPO_BROWSE_MAX_COMPARE_FILES` | `300` | Max changed files returned by an Artifacts diff before the result is truncated. |
