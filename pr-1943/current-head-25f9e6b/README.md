PR #1943 staging UI screenshot evidence for head `25f9e6baf04dd26d745f784fb3716fe71b150ad5`.

Captured against:

- App: `https://app.sammy.party`
- API: `https://api.sammy.party`
- Deploy run: `https://github.com/raphaeltm/simple-agent-manager/actions/runs/33202708513`
- Capture date: 2026-08-28 UTC

Surfaces covered:

- Project settings infrastructure compute-pool surface
- User/default cloud-provider settings compute-pool surface
- Installation/admin credentials compute-pool surface
- User default pool edit mode, including mobile save controls

Validation note:

- Hidden-scope placeholder copy was not present in captured DOM/screenshots.
- Candidate lists were readable on desktop and mobile in the captured states.
- A separate staging validation blocker was found: lazy reconcile/ensure and scheduler placement resolution hit a capacity-pool candidate upsert failure, so VM placement snapshots remained null.
