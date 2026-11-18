# Email-only project member is told "Your GitHub authorization has expired"

## Problem

A project member whose account has no GitHub link (email sign-in only) can be approved into a
GitHub-backed project, but every Send fails: `POST /api/projects/:id/tasks/submit` returns 401
because SAM needs the submitting user's own GitHub token, and the chat shows "GitHub sign-in
required / Your GitHub authorization has expired — please sign out and back in" with a "Sign out
and reconnect" button. The account never had GitHub, and on an install where GitHub links only
by matching email (better-auth account linking) signing out and back in cannot add it. The dialog
also renders without an opaque background over the composer (text overlaps at 1280x800).

## Context

Found 2026-11-11 on the self-hosted test box (task 01M74SZ6217NT5SCA7CWC95AZG) as
raphael@vmtest.sam2.party, an approved admin member of a GitHub-backed project. Related: the
project join flow lets an owner approve such a member ("Requester must reauthenticate with
GitHub" is advisory only), and there is no "Connect GitHub" control for an email account.

## Acceptance Criteria

- [ ] The error distinguishes "never linked" from "expired" and says what the user can do.
- [ ] Decide (human) whether approving a member who cannot run work should warn the owner, and
      whether email accounts get a "Connect GitHub" path.
- [ ] The GitHub sign-in required dialog has an opaque surface at mobile and desktop.
