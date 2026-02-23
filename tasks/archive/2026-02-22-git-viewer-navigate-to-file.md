# Git Viewer Navigate to Original File

**Created**: 2026-02-22
**Priority**: Medium
**Effort**: Small
**Tags**: `ui-change`

## Problem

When viewing a file in the git viewer (commit history / diff view), there is no way to navigate to the same file in the file browser. Users who want to see the current state of a file or edit it must manually find it in the file tree.

## Goal

Add a navigation action in the git file viewer that takes the user directly to the corresponding file in the file browser.

## Scope

- Add a "View in File Browser" button or link when viewing a file in the git viewer
- Navigate to the file browser with the target file selected/opened
- Handle cases where the file no longer exists (deleted in a later commit) with an appropriate message
