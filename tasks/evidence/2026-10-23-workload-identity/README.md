# Workload identity UI verification

Playwright captured these images from the real chat Details surface with mocked metadata at 375×667 and 1280×800. The tests exercise long names, special characters, all automation fields, copy success, clipboard failure, unavailable metadata and reopening to retry. All four tests passed.

The agent reviewed all six screenshots for readability, clipping, overflow and scrolling. No visual defects found. The scrolled screenshots show the final automation fields remain reachable inside the existing header scroll region. The reconnecting banner belongs to the mocked chat transport.

Command:

```sh
pnpm --filter @simple-agent-manager/web exec playwright test session-header-agent-info-audit.spec.ts --grep 'workload identity details' --project 'iPhone SE (375x667)' --project 'Desktop (1280x800)'
```

These fixtures prove rendering and interactions; staging verification separately checks the real metadata API and execution path.
