# PR #2030 final continuation evidence

The inherited 44-image mock gallery remains in `../2026-09-07-node-pools/`.
These additional captures cover the final corrections and live runtime checks.

## Reviewed captures

- `provisioning-native-desktop.png` / `provisioning-native-mobile.png`: local mock,
  real ProvisioningIndicator, refreshed dependencies at `a94bc7e91`. First-choice
  native allocation with differing compatibility aliases, unknown historical
  alias, and genuine long error. No false capacity-shortage message; View Logs
  works. No horizontal overflow. Rubric: hierarchy 4, clarity 5, mobile 4,
  accessibility 4, consistency 5. Existing compact stage-label ellipsis is retained.
- `live-terminal-desktop.png` / `live-terminal-mobile.png`: authenticated staging,
  binary `99a620928`, Claude test workspace `01M211VFWRSQ6KT0MVR2J0W864` on
  native CX23. Actual WebSocket output contains `PR2030-PTY-RETURNED` and
  `PR2030-MOBILE-RETURNED`, generated from split format arguments so an echoed
  input cannot satisfy the assertion. Mobile document has no horizontal overflow.
- `sleeping-conversation-desktop.png`: authenticated staging after UI sleep 200,
  showing both original marker readbacks and the Sleeping state.

Desktop is 1280×800; mobile 375×667. All captures listed above were opened and
reviewed for clipping, readability, responsive controls and overflow. The terminal
screenshots show actual execution, not a mock connection. Full screen-reader or
24-hour observability coverage is not claimed.

## Live lifecycle checkpoint

Session `bb03e84d-7778-412d-baf2-aec372da2364` created and read back
`PR2030-FINAL-1788889363195` in both `/workspaces/bullboard/.pr2030-final-check`
and `/home/node/.pr2030-final-check`. UI sleep returned 200 at 17:46 UTC.
Snapshot `01M211XXWT1ME9VGR2YVN77XE6` is available with degradation none and
home/WIP hashes; R2 lists home.tar (71,680 bytes), wip.bundle (21,259 bytes), and manifest.json (602 bytes).
The saved reservation is 1 GB and 0.25 vCPU. The profile default was then changed to 2 GB.
The empty VM was deleted through SAM, preserving the snapshot with zero live VMs.
Final wake/readback and cleanup remain pending and must be appended before merge.

An earlier Codex startup inherited the staging user's rejected `gpt-5.4-mini`
model. It executed no marker prompt; its workspace was deleted. The isolated
profile selects the configured Claude agent without changing the user's defaults.


`sleep-status-desktop.png` / `sleep-status-mobile.png` use the real header with
mock canonical Sleeping data and the observed old-task runtime-loss error. The
healthy snapshot case has no failure card; canonical failed recovery and active
runtime failure retain their cards. Both viewport captures were reviewed with no
overflow, clipping, or unreadable controls. These are local mocks; final staging
captures will verify the same state after deployment.


## Superseded sleep-header experiment

The `sleep-status-*` local captures document an experiment that was reverted.
Subsequent live wake proved the snapshot's required workspace row had been
removed by node deletion. Canonical Sleeping alone did not prove recoverability;
hiding its runtime error was unsafe. These images are retained as investigation
evidence and are not final UI acceptance evidence. The node deletion fix and a
new supported lifecycle test replace this experiment.
