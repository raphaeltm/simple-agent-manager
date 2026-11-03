# Chat UI right after a sleep: merged bubbles, and a ports poll against the slept container

## Problem

Seen on staging (Instant session `71a3d502-9f20-4388-aa8b-92c7c750c7be`, project Potato) while
verifying `sam/required-sleep-must-not-fail`. Neither is caused by that branch (no web changes).

1. **Merged assistant bubbles, missing user message.** Reloading the chat right after it slept
   mid-reply rendered the previous reply ("awake") and the next one ("This is the same request…")
   as one bubble, with the user's message between them missing. The messages API returned all
   four in the right order, and a fresh page load rendered them correctly. Likely a restored
   client cache from mid-stream merged with server messages.
2. **Ports poll after sleep.** Every sleep (API or the dock's Sleep button) is followed by two
   console errors: a CORS-blocked `GET https://ws-<id>.sammy.party/workspaces/<id>/ports?token=…`
   and `net::ERR_FAILED`. The page keeps polling ports of a workspace that is now sleeping.
   Waking a VM chat (which moves it to a new workspace) also logged four transient 404s from
   requests against the old, deleted workspace; a fresh load afterwards showed none.

## Acceptance Criteria

- [ ] Reloading a chat that just slept mid-reply renders the persisted message order
- [ ] The ports poll stops when the session or workspace is sleeping; no console errors after Sleep
- [ ] Playwright regression for both, mobile and desktop
