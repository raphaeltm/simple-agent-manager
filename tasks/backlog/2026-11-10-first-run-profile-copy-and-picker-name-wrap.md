# First-run profile copy promises pull requests; picker cards break short names mid-word

## Problem

1. The first agent profile that onboarding creates on a VM runtime is described as "Writes code
   and opens pull requests on its own machine" (`firstProfileRequest` in
   `apps/web/src/components/onboarding/choose-path/step-actions.ts`). The profile sets no
   instruction to open pull requests, and SAM itself never opens one, so a new user who reads the
   description expects a pull request that never arrives unless they ask for it.
2. On a 375px phone the new-chat picker's recent-profile cards break an ordinary profile name
   mid-word ("Brainstorm" / "er") next to the usage ring, instead of wrapping at a word boundary or
   giving the name more room.

## Context

Found on 2026-11-10 during the weekly docs update (local docs review and the
`docs-screenshots-profile-picker` capture). The Quickstart now tells users the description
overstates what the profile does; the copy should be fixed at the source.

## Acceptance Criteria

- [ ] The VM first-run profile's description matches its behaviour (either drop "opens pull
      requests", or add an explicit system-prompt instruction to open one and say so)
- [ ] Recent-profile cards on a 375px viewport do not break a single short word across lines
      (Playwright audit at 375px with names like "Brainstormer" and "Careful Builder")
- [ ] Quickstart step 2 updated if the profile behaviour changes
