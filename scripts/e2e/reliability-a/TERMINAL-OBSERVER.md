# Independent terminal observation — pending exact-head review and coordinator GO

This adds an observer alongside the unchanged reviewed `455b6ee4` probes. It authorizes no live operation, login, fixture, cache change or deployment. Execute only the reviewed exact scripts, after the coordinator clears containment and authorizes the cell.

Before actual completion, privately export A's complete `baseline.json` to the authorized independent controller. Run the observer in that controller with the same repository and exact fixture task branch. Keep expectations and copied baseline outside the fixture repository so they cannot change A's worktree evidence. Use the supported private artifact path for these files. Never print them or captured child streams. The observer uses Git and gh's ordinary existing authentication internally; never extract helper credentials.

```sh
python3 terminal-observer.py record --repository serverspresentation2025/crewai --branch sam/EXACT_TASK_BRANCH --baseline /private/controller/baseline.json --expectations /private/controller/expectations.json
```

Record must happen before canonical `complete_task`, with all B remote publication/cleanup frozen. It rejects a remote map different from the A baseline and records the task branch's complete observed PR inventory, including closed/merged PRs. A full PR result page fails closed rather than claiming completeness. Preserve this private expectations file unchanged.

After supported sleep/wake and A verification, invoke actual `complete_task` in the fixture. The controller must independently read canonical task/session completion and its timestamp, without reopening the completed task. The observer cannot authenticate canonical completion itself; its timestamp argument is that controller's verified input. It rejects missing, naive, future or pre-recording completion times. Only then run:

```sh
python3 terminal-observer.py check --repository serverspresentation2025/crewai --branch sam/EXACT_TASK_BRANCH --baseline /private/controller/baseline.json --expectations /private/controller/expectations.json --terminal-completed-at VERIFIED_CANONICAL_ISO_TIMESTAMP
```

The check runs from an authorized separate controller or next live context. It compares remote heads against A's baseline remote map, never the deliberately unpushed local HEAD. It separately compares the task-branch PR inventory against the pre-completion record. Console output contains only fixed boolean checks and integer statuses. A failure is not a PASS. The controller retains before/after timestamps and canonical completion identifiers as allowlisted evidence, exports final evidence before any explicit B cleanup, then follows the original one-fixture/configured-pool/15-minute/zero-cleanup constraints. Do not create extra compute just for observation.

Synthetic-only local validation:

```sh
python3 scripts/e2e/reliability-a/test-terminal-observer.py
```

This runs the actual observer CLI with private fake Git/gh canaries, failures, timeouts, malformed arguments/expectations and ref/PR mismatches. It establishes no live completion, authentication, provider or cleanup behavior. The imported process runner already has separately reviewed bounded timeout drain behavior; no arbitrary escaped-descendant termination is promised.
