# Secure D1 restore inputs

**Status:** Active  
**Type:** Security bug fix  
**Task:** `01KZT49S2E56R4VZSHPZX8NXRN`

## Problem

The production-credential-bearing D1 Time Travel workflow interpolates the
operator-controlled `timestamp` dispatch input directly into Bash source. Shell
syntax in that value can therefore execute on the GitHub runner before Wrangler
receives an argument. This is audit finding H1 from task
`01KZT1EVZTHTWK7QMVCKBB29TK` and is an immediate release blocker.

The fix must preserve the existing workflow dispatch interface, GitHub
Environment approvals, dry-run-first procedure, exact Pulumi-resolved database
names, both database targets, pre/post recovery evidence, and every Cloudflare-
documented restore-point form. It must not include other audit findings. Per the
explicit task override, this PR will not be merged or deployed to staging.

## Research Findings

1. On `origin/main` commit `fc1e394217248c3bd004b2e6619cf2344eade7e3`,
   `.github/workflows/d1-restore.yml` embeds `${{ inputs.timestamp }}` in five
   shell-script sites, including both credential-bearing restore commands.
   Shell quoting does not make GitHub expression interpolation safe because the
   expression is substituted before Bash parses the generated script.
2. The same workflow also interpolates the other dispatch inputs into `run:`
   blocks. Although choice/boolean inputs have narrower GitHub UI contracts, the
   durable workflow contract should prohibit every dispatch input from becoming
   shell source and should validate all values before secrets are exposed.
3. Cloudflare's current D1 documentation accepts restore points as Unix seconds,
   RFC3339/JavaScript date-time strings with an explicit timezone, or a lowercase
   hexadecimal bookmark in `8-8-8-32` groups. Paid-plan Time Travel retains 30
   days; future and older timestamp values must be rejected locally.
4. `scripts/quality/deployment-workflow-hardening.test.ts` is the existing static
   contract-test home for `d1-restore.yml`. `scripts/deploy/` contains executable,
   dependency-injected safety boundaries tested by the repository Vitest suite.
5. `apps/www/src/content/docs/docs/guides/self-hosting.mdx` is the canonical public
   recovery procedure. It currently documents only one RFC3339 example and must
   state the exact accepted forms, rejection/window rules, dry-run procedure,
   bookmark undo path, and targeting semantics.
6. `.claude/rules/02-quality-gates.md` requires a same-PR process fix for this bug
   class. The durable prevention rule is: untrusted GitHub expression values must
   never be interpolated into `run:` source; validate at a non-shell boundary and
   pass accepted data via environment variables or argument arrays.

## Implementation Checklist

- [x] Add failing executable parser tests for all documented valid Unix,
      RFC3339/JavaScript date-time, and bookmark forms.
- [x] Add failing parser tests for empty/malformed values, impossible dates,
      future/out-of-window values, metacharacters, newlines, command substitutions,
      and unsafe environment/database/dry-run inputs.
- [x] Add failing static workflow contract tests proving dispatch inputs never
      occur in shell source, validation precedes credential-bearing steps, safe
      environment/output transport is used, both database targets remain exact,
      and dry-run remains non-mutating.
- [x] Implement the restore-input parser/CLI as a non-shell trust boundary with a
      configurable recovery-window default and safe GitHub output emission.
- [x] Refactor `d1-restore.yml` to consume only validated step outputs through
      `env:`/quoted arguments while preserving approvals, targeting, evidence,
      dry-run behavior, and workflow interface compatibility.
- [x] Update the canonical self-host recovery guide with the exact safe procedure
      and every supported restore-point form.
- [x] Add the rule-02 process fix that bans untrusted GitHub expressions in shell
      source and requires adversarial workflow contract tests.
- [x] Run all relevant repository gates, required specialist reviews, independent
      implementation/test critiques, and a fresh adversarial bypass attempt.
- [x] Open exactly one non-draft PR against `main`, keep it unmerged, and skip
      staging by explicit instruction: https://github.com/raphaeltm/simple-agent-manager/pull/1810
- [ ] Resolve every applicable PR CI check to fully green.

## Acceptance Criteria

- [x] No operator-controlled dispatch input is interpolated into any `run:` block
      in `.github/workflows/d1-restore.yml`.
- [x] Injection payloads are rejected before a mutation or a command receiving
      Cloudflare/Pulumi credentials can run.
- [x] Valid Unix seconds, explicit-timezone RFC3339/JavaScript date-time strings,
      and valid D1 bookmarks remain accepted; invalid, future, and expired
      timestamp values fail closed with actionable errors.
- [x] `main`, `observability`, and `both` still target only their exact
      Pulumi-resolved databases, with dry runs performing no restore.
- [x] Production/staging GitHub Environment approvals and the existing dispatch
      input names/defaults remain compatible.
- [x] Pre-restore counts, Time Travel information, restore output (including undo
      bookmark evidence), post-restore counts, and dry-run summary remain present.
- [x] Canonical public documentation describes the exact safe preview/apply/undo
      procedure and validation constraints.
- [ ] All applicable local tests and GitHub CI checks pass; required reviewers
      report PASS or their credible findings are addressed.

## Post-Mortem

### What broke

An operator-provided D1 restore point was copied into Bash source in a workflow
that later receives production Cloudflare credentials. A malicious or accidentally
shell-active value could execute runner commands rather than being treated only as
a Wrangler argument.

### Root cause

The original D1 restore workflow introduced in commit `76c9536e13` used GitHub
expression interpolation inside multi-line `run:` scripts. Review treated quotes
around the interpolated expression as argument quoting, but GitHub substitutes the
expression before Bash parses the script.

### Timeline

- 2026-04-25: the D1 restore workflow was introduced with inline dispatch input.
- 2026-08-12: runtime audit task `01KZT1EVZTHTWK7QMVCKBB29TK` identified H1.
- 2026-08-12: this task independently reproduced H1 on current `origin/main`.

### Why it was not caught

The repository had deployment identity tests but no contract test banning
untrusted GitHub expressions in shell source and no executable adversarial parser
for recovery inputs. `bash -n` checks syntax only; it cannot detect pre-parse
expression substitution or malicious values that produce valid shell.

### Class of bug

CI/CD command injection caused by crossing a template-expression trust boundary
directly into shell source.

### Process fix

This PR will add a durable workflow-input rule to `.claude/rules/02-quality-gates.md`
and static/adversarial tests that fail whenever dispatch input re-enters shell
source or bypasses non-shell validation.

## References

- `.github/workflows/d1-restore.yml`
- `scripts/quality/deployment-workflow-hardening.test.ts`
- `apps/www/src/content/docs/docs/guides/self-hosting.mdx`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/22-infrastructure-merge-gate.md`
- `.claude/rules/31-migration-safety.md`
- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Cloudflare Wrangler D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

## Workflow Overrides

- Exactly one non-draft PR against `main`.
- Do not merge.
- Do not deploy or mutate staging.
- Stop only when every applicable CI check is green.
- The SAM-provisioned worktree already uses the assigned output branch, so the task
  record is created directly under `tasks/active/` on that branch rather than
  committing a separate task-only change to `main`.
