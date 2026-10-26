# GitHub trigger queue UI evidence

Playwright: `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/github-trigger-queue-audit.spec.ts --project='iPhone SE (375x667)' --project='Desktop (1280x800)'`

Eight cases passed at 375×667 and 1280×800: normal, long names and 35 events, empty history, and failed history requests. Checks cover horizontal/clipped overflow, clear queued/routing/routed/drop labels, and the routed Chat target.

Variants considered: separate metric cards, inline counters above the existing run list, or a new queue tab. Selected inline counters: it preserves the existing hierarchy and keeps all outcomes in one list on phones.

Implementation agent reviewed mobile normal and desktop many/long screenshots. No clipping or overflow found. Rubric: hierarchy 4/5, clarity 4/5, mobile usability 5/5, accessibility 4/5, consistency 5/5. Existing shared components and styles retained. The actual Opus 5.5 Chat review is a separate required gate; its task/result will be linked in the PR.
