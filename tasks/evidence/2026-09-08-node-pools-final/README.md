# PR #2030 final continuation evidence

The inherited 44-image mock gallery remains in `../2026-09-07-node-pools/`.
These additional captures cover continuation corrections and live runtime checks.
Historical and superseded captures below do not establish final-build acceptance.

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

## Historical live lifecycle checkpoint: `99a620928`

Session `bb03e84d-7778-412d-baf2-aec372da2364` created and read back
`PR2030-FINAL-1788889363195` in both `/workspaces/bullboard/.pr2030-final-check`
and `/home/node/.pr2030-final-check`. UI sleep returned 200 at 17:46 UTC.
Snapshot `01M211XXWT1ME9VGR2YVN77XE6` became available with degradation none and
home/WIP hashes; R2 listed home.tar (71,680 bytes), wip.bundle (21,259 bytes), and manifest.json (602 bytes).
The saved reservation was 1 GB and 0.25 vCPU. The profile default was then changed to 2 GB.
The empty VM was deleted through SAM, preserving snapshot artifacts with zero live
VMs at that checkpoint. The subsequent wake failed: node deletion had removed the
required workspace row and nulled `snapshot.workspace_id`. Artifact presence and
the Sleeping display did not establish recoverability. A fresh supported capture,
node deletion and wake with both marker readbacks and the saved reservation on
`c6d1a987f`, followed by cleanup, remain pending and must be recorded before merge.

An earlier Codex startup inherited the staging user's rejected `gpt-5.4-mini`
model. It executed no marker prompt; its workspace was deleted. The isolated
profile selects the configured Claude agent without changing the user's defaults.


## Superseded sleep-header experiment

`sleep-status-desktop.png` / `sleep-status-mobile.png` used the real header with
mock canonical Sleeping data and the observed old-task runtime-loss error. The
proposed display suppressed the runtime-loss card for the Sleeping fixture while
retaining canonical failed-recovery and active-runtime failure cards. Both local
mock captures were reviewed with no overflow, clipping or unreadable controls.
They document the `722997457` experiment, which was reverted in `c6d1a987f`.
Subsequent live wake proved the snapshot's required workspace row had been
removed by node deletion. Canonical Sleeping alone did not prove recoverability;
hiding its runtime error was unsafe. These images are retained as investigation
evidence and are not final UI acceptance evidence. The node deletion fix and a
new supported lifecycle test replace this experiment.

## Final candidate checkpoint: `c6d1a987f`

[Deployment and smoke run 34262971288](https://github.com/raphaeltm/simple-agent-manager/actions/runs/34262971288) passed; all PR checks including SonarCloud passed on this runtime SHA. Fresh session `fb2b4d63-bbad-4419-809e-6bb5d2d22dbc` created and read `PR2030-FINAL-1788892522814` in both original marker paths on the exact c6 VM binary. Its saved reservation is 250 CPU milliseconds, 1024 MB RAM and 40960 MB disk.

`final-markers-before-sleep-desktop.png` shows the agent readback. `final-terminal-desktop.png` and `final-terminal-mobile.png` show actual WebSocket command outputs on this runtime, with mobile overflow false. Both terminal captures were opened and reviewed.

Sleep returned 200 with available, non-degraded snapshot `01M215AEPJBTRVVPQCFT7SFVT8`. After the profile default changed to 2 GB, node deletion first returned 409 while strict provider termination remained unconfirmed; a reconciled request returned 200. The node disappeared, while workspace `01M2154KB0JNB384PGVDM50Z7K` and the snapshot's workspace reference remained. Both node references became null. `final-sleep-after-node-delete-desktop.png` / `final-sleep-after-node-delete-mobile.png` show the actual Sleeping state without a runtime error; both were opened and reviewed. The mobile capture is scrolled to the prior readback and composer.

One wake prompt was accepted with delivery `01M215KKYAARTRYB7FM9JS4B4P`; recovery claimed the snapshot and created replacement node `01M215M9Z05Q8B72NB2SA082VQ`. Final restored marker readback and saved-reservation verification remain pending at this checkpoint.

The earlier orphaned snapshot was separately removed by [guarded maintenance run 34264932643](https://github.com/raphaeltm/simple-agent-manager/actions/runs/34264932643), after a mutation-free preview. Exactly its three hash-verified objects and one unchanged snapshot row were deleted; independent R2 listing and D1 checks confirmed absence. No recovery metadata was rearmed.

## Final wake acceptance

The single queued wake prompt was accepted by the recovered agent at 18:58:33 UTC. The agent read both original paths without modification and returned `PR2030-FINAL-1788892522814` from each, followed by `WOKE-OK-1788893316876`. Replacement workspace `01M215Y4QTQJNJBH0GE2MKHYNG` runs on a distinct CX23 with the exact c6 VM binary and hourly native price 8800 micros. Its saved reservation remains 250 CPU milliseconds / 1024 MB RAM / 40960 MB disk, despite the profile's 2 GB default. Recovery was observed as waking attempt 1 and then restored; the successful transition resets the attempt counter to 0.

`final-restored-markers-desktop.png` / `final-restored-markers-mobile.png` show the authenticated readback in the same conversation. Both were opened and reviewed. `final-restored-terminal-desktop.png` / `final-restored-terminal-mobile.png` show successful actual terminal command outputs after recovery, with mobile overflow false. `final-lifecycle.json` contains the bounded IDs, timestamps, marker strings and saved reservations used for this proof.

Supported session stop subsequently returned 200 and removed the fresh snapshot metadata. Remaining owned workspace/node/project cleanup is tracked separately below. No manual recovery metadata edits or duplicate wake prompts were used.

## Cleanup accepted

Normal API deletion confirmed removal of all four remaining owned workspace records, the replacement VM, the isolated profile, and the final test project. Both owned projects are absent. Final D1 counts are zero for owned workspaces, snapshots, profiles, tasks and session summaries, and zero for live staging nodes. All 18 inventoried R2 prefixes are empty. Seven checked owned node/workspace DNS names are absent. The two unrelated sleeping workspaces remain sleeping. Pool revision 15, balanced/queue policy and all 135 candidate ID/status pairs match the baseline, with nine active offerings.

Three older node rows remain as deleted lifecycle audit records with termination proof; normal ownership lookup intentionally excludes deleted nodes and returns 404. These are retained records, not live VMs. Project deletion uses normal API storage semantics; no direct purge of ProjectData Durable Object transcript storage is claimed. `final-cleanup.json` records the bounded final checks.

Runtime code, dependencies, infrastructure and workflows remain identical to staged `c6d1a987f`; subsequent commits contain documentation/evidence and an exact reviewed non-secret archive fingerprint. Final-head CI and authorized merge/production monitoring are tracked in PR #2030.

The archive move changed one existing non-secret checklist finding's exact path/line fingerprint. The security baseline adds only that reviewed digest in its existing expiring group; original entries and expiration remain unchanged. Both current-tree (52 reviewed, zero new) and PR-range (4 reviewed, zero new) scans passed locally. No scanner rule or broad exclusion changed.
