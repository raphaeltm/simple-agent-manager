# Fix GitHub Personal Installation Leak

## Problem

Lionello's production account received a per-user `github_installations` row for RaphaelTM's personal GitHub App installation. That allowed SAM to mint a full GitHub App installation token for RaphaelTM when Lionello loaded repository selection, exposing RaphaelTM private repositories in the hosted app.

The bad row was removed manually from production, but code still needs to prevent recreation.

## Research Findings

- Production row `01KTEWYMY2QASTZRD78XD3B673` linked Lionello (`P7PNswz1CheYV8RmIA5ZpAPsNt6mSbqP`, GitHub id `591860`) to RaphaelTM's personal installation (`external_installation_id = 108667778`, GitHub id `910895`).
- The row was created by `GET /api/github/installations`, not by project creation itself.
- `apps/api/src/routes/github.ts` syncs all installations returned by GitHub's `/user/installations` endpoint into per-user SAM rows.
- PR #935 removed the old guard that skipped personal installations during sync.
- PR #1119 added per-user stored installation ids and `external_installation_id`, allowing duplicate per-user links to the same external installation instead of conflicting.
- `GET /api/github/repositories` currently lists repositories by minting an app installation token for each stored user row.

## Implementation Checklist

- [ ] Add a GitHub user identity helper that reads the authenticated user's GitHub id/login from the OAuth token.
- [ ] Update direct installation sync so personal installations are stored only when the installation account is the authenticated GitHub user.
- [ ] Keep shared organization discovery behavior intact for verified org installations.
- [ ] Add regression tests covering cross-user personal installation sync denial.
- [ ] Add regression tests confirming the current user's own personal installation still syncs.
- [ ] Add regression tests confirming verified shared org installation sync still works.
- [ ] Run focused API tests and quality checks.
- [ ] Perform local critical review with security and test focus before PR.

## Acceptance Criteria

- A user cannot acquire another user's personal GitHub App installation row via installation sync.
- A user's own personal installation can still be linked.
- Verified shared organization installation discovery continues to work.
- Tests prove the regression using realistic route-level sync behavior.
- PR is opened with the production cleanup note and code-level prevention.
