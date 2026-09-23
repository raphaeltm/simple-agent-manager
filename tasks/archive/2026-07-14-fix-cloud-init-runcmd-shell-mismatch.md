# Fix Cloud-Init Runcmd Shell Mismatch

## Problem Statement

A fresh Hetzner node created during GitLab staging validation reached a false failed
cloud-init state:

```text
/var/lib/cloud/instance/scripts/runcmd: 97: set: Illegal option -o pipefail
cc_scripts_user failed
```

The VM agent had already started, so the workspace and GitLab push validation
succeeded. The remaining deployment-role Caddy setup command did not run, however,
and any future commands after that failing entry would also be skipped.

Source idea: `01KXFZPG6M70PJF72CKFZVK99B`.

## Constraints

- The original 2026-07-14 task explicitly skipped staging mutation, but the
  2026-07-20 parent PR-resolution task supersedes that waiver and requires
  exact-head staging before merge.
- Provision a fresh real Hetzner staging node through SAM's supported platform
  credential fallback and verify cloud-init completes without the Dash error.
- On that staged candidate, complete the core user journeys with genuine rendered
  responses from both Claude and Codex before merge.
- Retain local execution of the rendered command under its real interpreter plus
  high-quality automated tests as the deterministic regression gate.
- Keep the production change minimal and avoid a new abstraction or dependency.

## Research Findings

- `packages/cloud-init/src/template.ts` is the production template. The similarly
  named `scripts/vm/cloud-init.yaml` file is only a reference and does not contain
  this Caddy block.
- Cloud-init scalar `runcmd` entries execute through `/bin/sh`. On Ubuntu and
  Hetzner images that is Dash, which rejects Bash's `pipefail` option.
- The Caddy setup block contains `set -euo pipefail` even though it has no
  pipeline or Bash-only behavior. `set -eu` preserves fail-fast and unset-variable
  checking while remaining POSIX-compatible.
- The other `pipefail` occurrences in the rendered config are files under
  `write_files` with explicit `#!/bin/bash` shebangs; they are not affected.
- Existing tests parse the rendered YAML and inspect Caddy ordering/guards, but
  never execute the command through the interpreter cloud-init uses. That allowed
  a structurally valid YAML command with an invalid runtime shell contract to pass.
- Regression origin: commit `1a41b4e741f6fca5a72c13f0b3e7cccba7a5bc3f`
  (PR #1308, 2026-06-13) introduced the Caddy `runcmd` block and the incompatible
  shell option.
- A prior Origin CA staging incident already established the same interpreter
  fact, but `.claude/rules/06-vm-agent-patterns.md` did not apply to
  `packages/cloud-init/**` and did not encode an executable shell-contract test.
- Relevant guidance: `packages/cloud-init/AGENTS.md`,
  `.claude/rules/02-quality-gates.md`,
  `.claude/rules/06-vm-agent-patterns.md`,
  `.claude/rules/22-infrastructure-merge-gate.md`, and
  `tasks/archive/2026-03-12-fix-tls-yaml-indentation-and-process.md`.

## Implementation Checklist

### Runtime Fix

- [x] Replace the Bash-only Caddy `runcmd` option with POSIX-compatible strict
      mode while preserving fail-fast behavior.
- [x] Confirm no other implicit-`/bin/sh` `runcmd` entry uses Bash-only syntax.

### Regression Coverage

- [x] Add a parsed-YAML test helper that selects the rendered Caddy command rather
      than reading template source.
- [x] Execute the rendered workspace-role command through `/bin/sh` with harmless
      `logger` and `mkdir` stubs and assert the skip path succeeds without mutation.
- [x] Execute the rendered deployment-role command through `/bin/sh` with the
      same stubs and assert the expected Caddy directories are requested.
- [x] Demonstrate locally that the new behavioral test fails against the old
      `pipefail` command and passes after the fix.

### Process and Documentation

- [x] Extend the path scope and cloud-init guidance in
      `.claude/rules/06-vm-agent-patterns.md` so scalar `runcmd` entries must be
      POSIX-compatible or invoke Bash explicitly, with tests run under the declared
      interpreter.
- [x] Record final local validation evidence and complete the post-mortem below.

### Validation

- [x] Focused cloud-init test suite passes on the current-main integration (178/178).
- [x] Cloud-init package typecheck and build pass on the current-main integration.
- [x] Full repository lint, typecheck, test, and build pass on the current-main integration.
- [x] Current-head task completion and relevant specialist reviews pass.
- [ ] GitHub CI passes (Phase 7 gate pending).
- [ ] Exact-head staging deployment and built-in smoke suite pass.
- [ ] A fresh real Hetzner node reaches a clean cloud-init completion state.
- [ ] Genuine Claude and Codex responses render through the staged core chat journey.

## Acceptance Criteria

- [x] Both workspace and deployment Caddy setup commands exit successfully under
      `/bin/sh` in local behavioral tests.
- [x] The deployment variant still requests creation of
      `/etc/caddy`, `/var/lib/caddy`, and `/var/log/caddy`; the workspace variant
      does not.
- [x] Reintroducing `set -o pipefail` makes the behavioral regression test fail
      on the Ubuntu/Dash contract used by cloud-init.
- [x] Generated cloud-init remains valid parsed YAML and within Hetzner's size
      limit.
- [x] Future cloud-init changes receive path-scoped guidance to test rendered
      commands with their actual interpreter.
- [ ] A fresh exact-head Hetzner staging node completes cloud-init without
      `Illegal option -o pipefail` or `cc_scripts_user failed`.
- [ ] Core staged chat returns genuine rendered responses from both Claude and Codex.
- [ ] The PR merges only after local validation, specialist review, and CI are
      green and exact-head staging validation passes.

## Post-Mortem

### What Broke

Cloud-init reported `cc_scripts_user failed` on fresh Hetzner nodes because the
Caddy setup entry exited before evaluating its role guard. The VM agent happened
to be running already, which limited immediate impact but left provisioning in a
failed state and skipped the tail of the generated `runcmd` script.

### Root Cause

Commit `1a41b4e741f6fca5a72c13f0b3e7cccba7a5bc3f` added
`set -euo pipefail` to a scalar cloud-init `runcmd` block. The implementation
implicitly assumed Bash, while cloud-init generated a script executed by
`/bin/sh`.

### Timeline

- 2026-06-13: PR #1308 introduced the incompatible Caddy setup block.
- 2026-07-14: Exact-commit GitLab staging validation surfaced the error in a
  fresh Hetzner node's `cloud-init-output.log`.
- 2026-07-14: The GitLab release proceeded because the VM agent, workspace, and
  credential validation had succeeded; the unrelated issue was captured as a
  separate idea for this fix.

### Why It Wasn't Caught

Tests parsed the YAML and asserted that the Caddy guard and ordering existed, but
did not execute the rendered block under `/bin/sh`. Shell compatibility was
therefore outside the tested contract. Existing path-scoped VM guidance also did
not load for `packages/cloud-init/**`.

### Class of Bug

Generated-script interpreter contract mismatch: structurally valid configuration
contains commands for a different shell than the runtime actually invokes.

### Process Fix

Update `.claude/rules/06-vm-agent-patterns.md` to apply to the cloud-init package
and require scalar `runcmd` entries to remain POSIX-compatible unless they invoke
Bash explicitly. Changed command blocks must be tested by parsing the rendered
YAML and executing them with harmless boundary stubs under the declared
interpreter.

## Local Experiment Evidence

- The runner resolves `/bin/sh` to `/usr/bin/dash`, matching the Ubuntu shell
  contract that produced the Hetzner failure.
- Red state: with `set -euo pipefail` still rendered, both new role tests exited
  status 2 with `/bin/sh: 1: set: Illegal option -o pipefail`; 175 existing tests
  passed and the 2 new interpreter-contract tests failed.
- Green state: after changing only that strict-mode line to `set -eu`, all 177
  cloud-init tests passed. The workspace role logged its skip path without calling
  `mkdir`; the deployment role requested exactly
  `mkdir -p /etc/caddy /var/lib/caddy /var/log/caddy`.
- Cloud-init package typecheck and build passed. Remaining Bash-only syntax in the
  rendered template belongs to `write_files` scripts with explicit
  `#!/bin/bash` shebangs, not scalar `runcmd` entries.
- Full-repository validation passed: lint 7/7 tasks, typecheck 16/16 tasks, tests
  19/19 tasks (including 5,975/5,975 API tests), and isolated production build
  9/9 tasks. Running the full test and build commands concurrently first caused
  an `apps/www` generated-artifact race; rerunning each command in isolation
  passed and is the recorded result.
- No staging deployment or mutation was performed. The user explicitly replaced
  that gate with the real-`/bin/sh` experiment and high-quality local regression
  coverage recorded above.

## Task Completion Validation

The mandatory Phase 4 validator passed on 2026-07-14:

| Check                   | Status | Evidence                                                                                                     |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| A: Research → Checklist | PASS   | Every actionable finding maps to the runtime, regression, or process checklist.                              |
| B: Checklist → Diff     | PASS   | Checked implementation items are present in the template, tests, rule, or recorded red/green experiment.     |
| C: Criteria → Tests     | PASS   | Rendered workspace and deployment commands execute through real `/bin/sh`; YAML/size coverage remains green. |
| D: UI → Backend         | N/A    | No UI or API data path changed.                                                                              |
| E: Multi-Resource       | N/A    | No resource selection logic changed.                                                                         |
| F: Vertical Slice       | PASS   | The test covers generation, YAML parsing, actual shell execution, and asserted stubbed side effects.         |

The remaining unchecked specialist-review, CI, and merge items are explicitly
future `/do` gates, not implementation omissions.

## Specialist Reviews

Phase 5 completed on 2026-07-14. The local subagent runtime interrupted two
review attempts before producing output, so the same required read-only skill
procedures were rerun directly against `main...HEAD`:

| Reviewer                     | Status | Result                                                                                                                                            |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task completion validator    | PASS   | Checks A-F pass; no planned-vs-actual or vertical-slice gap.                                                                                      |
| Test engineer                | PASS   | Both role branches run the parsed production command through real `/bin/sh` with isolated executable stubs and behavioral side-effect assertions. |
| Constitution validator       | PASS   | No configurable business value, URL, timeout, limit, or identifier was added; interpreter and Caddy filesystem paths are runtime contract values. |
| Documentation sync validator | PASS   | The path-scoped rule matches the production template and runtime; no public API, env, schema, or deployment documentation changed.                |

No specialist raised a blocking or advisory code finding.

## 2026-07-20 Current-Head Revalidation

- Integrated current `main` (including merged PR #1618) with a normal merge.
- Focused cloud-init suite: 178/178 tests; package typecheck and production build pass.
- Complete repository gates: lint 7/7 with zero errors, typecheck 16/16,
  production build 9/9, and tests 19/19 (API 6,190/6,190).
- Test-engineer review: PASS. The tests extract the rendered scalar from parsed
  YAML, execute both role branches through `/bin/sh`, isolate external side
  effects behind harmless `logger`/`mkdir` stubs, and assert the boundary calls.
- Constitution review: PASS. `set -eu` is the fixed POSIX interpreter contract;
  no configurable URL, timeout, limit, identifier, or business value was added.
- Documentation review: PASS. The path-scoped rule describes the production
  runtime and test contract; no public API, environment, or deployment interface changed.
- Task-completion audit: PASS for implementation readiness. Checks A/B/C/F pass;
  D/E are N/A. CI, exact-head deployment, fresh-node boot, and live chat remain
  explicit unchecked lifecycle gates, so this task stays active until they pass.

## References

- SAM idea `01KXFZPG6M70PJF72CKFZVK99B`
- `packages/cloud-init/src/template.ts`
- `packages/cloud-init/tests/generate.test.ts`
- `.claude/rules/06-vm-agent-patterns.md`
- `tasks/archive/2026-03-12-fix-tls-yaml-indentation-and-process.md`
- `apps/www/src/content/blog/sams-journal-one-time-things-need-locks.md`
