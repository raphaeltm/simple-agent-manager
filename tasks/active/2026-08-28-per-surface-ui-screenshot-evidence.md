# Per-Surface UI Screenshot Evidence Enforcement (PR #1943 repair)

## Context

- Narrow follow-up repair for draft PR #1943 (`sam/compute-pools-integration`).
- Coordinator verification found the current `scripts/quality/check-preflight-evidence.ts`
  fix (commit `9f3a0d013`) only requires a desktop screenshot link and a mobile screenshot
  link anywhere in `UI Screenshot Evidence`. It does NOT enforce evidence for every changed
  UI surface. One desktop line + one mobile line can satisfy multiple changed surfaces.
- Constraint from coordinator: do not deploy to staging, do not merge, keep scope minimal,
  push to `sam/compute-pools-integration` or a child PR targeting it, report exact commit
  SHA + files changed + validation results.

## Raphaël's standing requirement

> If a PR has UI changes, screenshots must be taken with Playwright using mock data that
> pushes the limits of the UI. Any changed surface must have desktop and mobile screenshots
> posted in the PR, and the agent must attest that they reviewed screenshots for quality
> control and found/fixed/documented issues.

## Research Findings

- `scripts/quality/check-preflight-evidence.ts` currently validates the `ui-change` class by
  scanning the whole `UI Screenshot Evidence` section for global desktop/mobile/link/Playwright/
  stress/attestation signals (`check-preflight-evidence.ts:203-266`).
- The PR template's `UI Screenshot Evidence` section today is a flat 5-line global form
  (`.github/pull_request_template.md:39-49`).
- Rule 17 documents the evidence gate as global desktop/mobile bullet lines
  (`.claude/rules/17-ui-visual-testing.md:48-56,161-171`).
- Tests: `scripts/quality/check-preflight-evidence.test.ts` has 3 tests (1 fail + 2 pass,
  both pass tests use the old global-only format — must be rewritten to per-surface format).
- The checker runs via `pnpm quality:preflight` (`ci.yml` `preflight-evidence` job) and is
  invoked only for pull_request events; non-UI PRs must keep existing behavior.
- Evidence links accepted: embedded image `![alt](url)`, direct image URL
  (`https://...png|jpg|jpeg|webp`), or GitHub PR-comment `#issuecomment-<n>` URL.
- `.tmp/` is gitignored (`.gitignore:64-65`) and is the checker test scratch-dir convention;
  keep it.
- `waitForTimeout(600)`: NOT part of this patch. The shared Playwright helper
  `apps/web/tests/playwright/audit-helpers.ts:40` plus ~60 call sites across audit specs use
  it; replacing it with an observable condition is not practical inside this narrow
  checker/template/rule patch without destabilizing the visual-audit suite. Reported
  explicitly per task instruction.

## Implementation Checklist

- [ ] PR template: replace the flat 5-line `UI Screenshot Evidence` block with a clear
      directive to enumerate every changed surface and a repeated per-surface block
      containing desktop evidence, mobile evidence, mock/stress data, and screenshot
      quality review (accepting image links or `#issuecomment-...`).
- [ ] Checker: parse `UI Screenshot Evidence` into per-surface blocks via
      `#### Surface: <name>` headings; for each surface require desktop evidence link AND
      mobile evidence link; require mock/stress data and QC attestation per surface;
      reject section with zero enumerated surfaces (kills global-only evidence).
- [ ] Checker: keep prior behaviors — Playwright mention, section required when `ui-change`
      checked, non-UI PRs untouched.
- [ ] Rule 17: update "Preflight Enforcement" + "PR Evidence Gate" to document the
      per-surface contract.
- [ ] Tests: rewrite existing pass tests to per-surface format (multi-surface case with
      image links and `#issuecomment-...`); add failing tests for (a) one surface missing
      mobile/desktop, (b) global-only evidence that does not enumerate surfaces.
- [ ] Keep `.tmp/` test scratch convention unchanged.
- [ ] Run `pnpm quality:scripts:test scripts/quality/check-preflight-evidence.test.ts`.
- [ ] Run relevant typecheck/lint for scripts/quality files.

## Acceptance Criteria

- A ui-change PR whose `UI Screenshot Evidence` enumerates surfaces and gives each surface
  desktop + mobile evidence (image link or `#issuecomment-...`) PASSES.
- A ui-change PR with one surface missing mobile or desktop evidence FAILS with a message
  naming the surface.
- A ui-change PR with only global desktop/mobile lines (`libell Desktop screenshots:`/
  `Mobile screenshots:` once for all surfaces, no surface enumeration) FAILS.
- A non-UI PR (ui-change unchecked) is unaffected.
- `.tmp/` convention intact; no staging; no merge.

## Validation Log

- `pnpm quality:scripts:test scripts/quality/check-preflight-evidence.test.ts` — baseline 3 pass.
- (filled in during implementation)

## Pull Request

- Child PR targeting `sam/compute-pools-integration` (created from this worktree branch).