# Verification-only probe revision — held pending coordinator resume

No product source changes, new live submissions, profile/cache changes, or deployment are authorized by these assets. The coordinator must resolve containment/cache prerequisites and approve reuse after independent security review. The first VM evidence artifact remains unchanged. The interrupted Instant/Claude cell is not a clean PASS.

Use only these Sol-authored scripts verbatim. The fixture model must not inspect the helper with Read, invent helper commands, print child-process streams, or invoke unsupported vm-agent version flags. No free-form helper negative checks. Both scripts capture Git/helper stdout and stderr privately. Console output contains fixed-key booleans and integer statuses only; no raw helper text, credentials, Git refs, exception payloads, or command diagnostics. Never append `cat` of the helper, probe internal state, or a captured subprocess object.

Local validation (no staging, credentials or provisioning):

```sh
python3 scripts/e2e/reliability-a/test-probes.py
```

This runs the ACTUAL CLI assets with synthetic-only helper/Git/gh canaries on stdout and stderr, including command failures/timeouts. It also verifies malformed-argument sanitization, descendant timeout termination, publication-path stream capture, failed-inspection publication gating, and A's real local Git fixture, staged-user-work preservation and tamper detection with canary stderr injected. It does not establish live provider behavior.

For a coordinator-approved future fixture, run from the supported repository root:

```sh
python3 b-probe.py --disposable-repository --repository serverspresentation2025/crewai --branch sam/reliability-b-UNIQUE-LOWERCASE-CELL
python3 git-probe.py prepare --disposable-repository
python3 git-probe.py check
```

The placeholder branch must be replaced with a fresh exact lowercase test branch. B explicitly creates a narrow local empty test commit in a temporary normal checkout, verifies its tree did not change, and pushes only that test branch. B refuses publication if A's baseline already exists. No force push or default-branch mutation. GitHub access and negative helper results are captured privately and emitted only as booleans/statuses. Missing-path credential presence is an observation, not an asserted security denial. A deliberately creates one local fixture commit and captures dirty/staged/workflow state without publishing. It prints only boolean checks/statuses; exact refs/index/hashes remain in the private `.reliability-a/baseline.json` inside the snapshot-supported root.

Export A baseline only through the supported private library/artifact path, never raw helper/tool output. Verify it contains only the intended fixture Git state, not credentials. Preserve final evidence before any B remote-branch cleanup; cleanup remains a separate explicitly named operation owned by the coordinator. The scripts do not delete remote branches.

Each live cell still requires actual runtime/harness and pinned-artifact proof, external Git/PR observations, strict supported sleep/wake and actual complete_task. A blocked guard is not a PASS and must not be bypassed. Complete-task SHA evidence belongs in supported verification/notes fields, with prUrl separately. All original one-fixture/configured-pool/deadline/confirmed-cleanup constraints remain.

No supported session-message redaction or exact GitHub installation-token cache invalidation interface was found during containment. These scripts do not attempt manual DB/KV edits or broader credential rotation. Do not resume just because revocation succeeded if the coordinator has not cleared the remaining cache prerequisite.
