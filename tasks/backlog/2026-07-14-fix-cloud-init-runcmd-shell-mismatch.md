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

- The user explicitly requested that this task skip staging deployment and all
  staging mutation.
- Replace the normal infrastructure staging gate with local execution of the
  rendered command under its real interpreter plus high-quality automated tests.
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

- [ ] Replace the Bash-only Caddy `runcmd` option with POSIX-compatible strict
  mode while preserving fail-fast behavior.
- [ ] Confirm no other implicit-`/bin/sh` `runcmd` entry uses Bash-only syntax.

### Regression Coverage

- [ ] Add a parsed-YAML test helper that selects the rendered Caddy command rather
  than reading template source.
- [ ] Execute the rendered workspace-role command through `/bin/sh` with harmless
  `logger` and `mkdir` stubs and assert the skip path succeeds without mutation.
- [ ] Execute the rendered deployment-role command through `/bin/sh` with the
  same stubs and assert the expected Caddy directories are requested.
- [ ] Demonstrate locally that the new behavioral test fails against the old
  `pipefail` command and passes after the fix.

### Process and Documentation

- [ ] Extend the path scope and cloud-init guidance in
  `.claude/rules/06-vm-agent-patterns.md` so scalar `runcmd` entries must be
  POSIX-compatible or invoke Bash explicitly, with tests run under the declared
  interpreter.
- [ ] Record final validation evidence and complete the post-mortem below.

### Validation

- [ ] Focused cloud-init test suite passes.
- [ ] Cloud-init package typecheck and build pass.
- [ ] Full repository lint, typecheck, test, and build pass.
- [ ] Task completion and relevant specialist reviews pass.
- [ ] GitHub CI passes.
- [ ] Staging is explicitly recorded as skipped by user instruction.

## Acceptance Criteria

- [ ] Both workspace and deployment Caddy setup commands exit successfully under
  `/bin/sh` in local behavioral tests.
- [ ] The deployment variant still requests creation of
  `/etc/caddy`, `/var/lib/caddy`, and `/var/log/caddy`; the workspace variant
  does not.
- [ ] Reintroducing `set -o pipefail` makes the behavioral regression test fail
  on the Ubuntu/Dash contract used by cloud-init.
- [ ] Generated cloud-init remains valid parsed YAML and within Hetzner's size
  limit.
- [ ] Future cloud-init changes receive path-scoped guidance to test rendered
  commands with their actual interpreter.
- [ ] The PR merges only after local validation, specialist review, and CI are
  green; no staging deployment is triggered.

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

## References

- SAM idea `01KXFZPG6M70PJF72CKFZVK99B`
- `packages/cloud-init/src/template.ts`
- `packages/cloud-init/tests/generate.test.ts`
- `.claude/rules/06-vm-agent-patterns.md`
- `tasks/archive/2026-03-12-fix-tls-yaml-indentation-and-process.md`
- `apps/www/src/content/blog/sams-journal-one-time-things-need-locks.md`
