# Avoid deleted-workspace requests when opening ended chat history

## Reproduction and evidence

On staging, open Deployment Test 1 session `79aaaa68-6ddc-464f-ab23-9389c08d1a69` (an old completed smoke test). The transcript renders, but the browser requests `/api/workspaces/01KZR0X61YM6YG7G9P7JSW1NBZ`, which returns 404 because the workspace no longer exists. Chromium reports the resource failure in the console.

This was observed with history restored to root before compact migration succeeded, so it is not evidence of a compact archive read regression. Keep it distinct from the temporary exact-read fence raised by the failed remigration journal, which is handled by the compact archive task's successor-intent fix.

## Acceptance criteria

- [ ] Determine which optional ended-session surface fetches workspace state.
- [ ] Render retained history without a failed request for a known deleted workspace, while preserving access to available workspace/snapshot actions.
- [ ] Add an ended-session/deleted-workspace browser regression scenario.
