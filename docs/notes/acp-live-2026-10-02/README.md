# ACP staging browser evidence — 2026-10-02

Playwright captured these images from the deployed application at code head
`5935e8219`, using a disposable fixture under the staging PRIMARY account. The
parent personally reviewed every image. Desktop is 1280×800 and mobile is
375×667. Pending views had no horizontal document overflow or page errors;
permission text and actions were readable and reachable on both viewports.

| Evidence | Desktop | Mobile |
| --- | --- | --- |
| VM live permission, before answer | [image](vm-pending-desktop.png) | [image](vm-pending-mobile.png) |
| VM final transcript, **after cleanup** | [image](vm-final-after-cleanup-desktop.png) | [image](vm-final-after-cleanup-mobile.png) |
| Instant cancelled permission during recovery | [image](instant-cancelled-desktop.png) | [image](instant-cancelled-mobile.png) |

The VM's first pending request survived [reload](vm-reloaded-pending.png).
Selecting `allow-once` through the browser produced the
[delivered-answer state](vm-delivered-answer.png). The parent also chose
`allow-once` for the exact Python canary request. Cloudflare confirmed both
answers, then recorded the command stdout and final continuation before cleanup.
The runbook records the interaction IDs and timestamps.

The final transcript images were taken **after** the operator stopped the
already-completed session. Their Failed/Retryable banner reflects the cleanup
cancellation (`Archived by user`, 21:49:20.154 UTC); it is not evidence of a
permission-continuation failure. There is no pre-cleanup final-response image.

The Instant images show a cancelled request with no answer buttons and a
Recovery container badge. No answer was submitted. The whole standalone runtime
received SIGTERM before cancellation; its sender remains unknown. These images
prove interruption visibility, not successful Instant continuation. Forms were
never enabled or answered. Both fixtures and temporary profiles were cleaned up;
staging was restored to disabled flags.
