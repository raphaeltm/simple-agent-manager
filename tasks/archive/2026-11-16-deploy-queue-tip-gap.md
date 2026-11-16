# Close the automatic production deploy queue gap

## Problem

Since #2763 main CI runs overlap and can finish out of order. `deploy.yml` keeps every
trusted candidate in the single `deploy-production` concurrency group, where GitHub keeps
only one pending run. An older commit X's deploy run can replace the tip Y's pending run;
X then fails closed at the tip check and nothing deploys Y until the next merge or a manual
dispatch. Reported in idea 01M7FYGMEESYH3AJZJ0CT3NKCZ ("Known limit").

## Research

- `.github/workflows/deploy.yml`: `validate-automatic-dispatch` passes
  `github.event.workflow_run.head_sha` to `validateAutomaticProductionDispatch`, which only
  checks it equals the tip.
- `scripts/deploy/validate-production-dispatch.ts`: manual path already resolves the tip
  and verifies a successful `CI` push run on main for that exact SHA (`selectSuccessfulCiRun`).
- `mark-production-deployment` records a GitHub deployment (`environment=production`,
  payload `{workflow: deploy.yml, dry_run: false}`, status success). `release.yml` already
  reads the latest such marker to find the deployed SHA.
- `deploy-reusable.yml` falls back to `github.sha` when `target_commit_sha` is empty, so the
  deploy job must be skipped when the validator selects nothing.
- `ci.yml` concurrency comment and `.claude/commands/do.md` Phase 7b describe the gap and
  the manual recovery. The Codex `do` skill has no copy of that wording.

## Design

Automatic path validates the current main tip, read after the queue, not the triggering
SHA: tip with a successful CI push run on main in this repo -> deploy the tip, unless the
latest successful production marker is already the tip; tip CI pending/failed -> end green
without deploying (the tip's own CI completion triggers a later run). Every API error fails
closed. Alternative (re-dispatch with `actions: write`) rejected: needs a write permission
and a second run; design A needs only a read-only `deployments: read` on one job.

## Checklist

- [x] Validator: automatic path resolves tip, checks tip CI, checks deployed marker
- [x] deploy.yml: pass triggering SHA, job-level read permissions, skip deploy when no SHA selected
- [x] Tests: out-of-order sequences via a queue simulation through the real validator; tip green/pending/failed/already deployed/API error; non-tip control
- [x] Update ci.yml comment and do.md Phase 7b
- [x] Security-auditor review (0 critical/high; LOW 1-2 fixed, LOW 3 posted to feature.ship-faster for PR #2770 owner, LOW 4 accepted); idea note

## Acceptance Criteria

- [x] After any out-of-order CI completion sequence, the green tip is deployed with no intervention
- [x] Only a main tip with a successful CI push run on that exact SHA is ever deployed
- [x] Manual dispatch path and emergency override unchanged
- [x] API errors fail closed (no deploy, red run)

## Notes

- If the tip's deploy failed (no marker), a later out-of-order CI completion retries the tip's deploy. Deploys are idempotent; previously the tip stayed undeployed until the next merge.
- If the tip itself triggered the run but no successful CI run is found for it, the gate fails red (API inconsistency) instead of skipping silently (security-auditor LOW 1).
