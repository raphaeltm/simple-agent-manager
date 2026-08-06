# Keep self-host wizard generated secrets memory-only

## Problem

The public self-host setup wizard currently stores generated `GH_WEBHOOK_SECRET` and `PULUMI_CONFIG_PASSPHRASE` values in `localStorage` as part of `sam-self-host-wizard-v1`. That lets a future browser session restore the values, but it also leaves generated setup secrets at rest in browser storage.

Implement R6 finding 1 only for `apps/www`: generated webhook secret and Pulumi passphrase must remain tab-memory-only by default. Non-secret wizard progress, navigation, account type, and non-secret fields must remain restorable. Existing wizard outputs and the setup flow must continue to work in the same tab.

## Research findings

- Affected implementation: `apps/www/public/scripts/self-host-wizard.js`.
- The storage key is `sam-self-host-wizard-v1`.
- `FIELD_IDS` persists non-secret text inputs only; explicitly-entered secret input fields are already not persisted.
- Current `loadState()` restores `saved.webhookSecret` and `saved.passphrase`.
- Current `saveState()` writes `webhookSecret` and `passphrase`.
- Generated webhook secret is created by `generateAppLink()` and rendered into `#sh-webhook-secret`.
- Generated Pulumi passphrase is created by `ensurePassphrase()` and rendered into `#sh-passphrase`.
- GitHub Environment output generation depends on `state.webhookSecret` and `state.passphrase` via `getEnvData()`.
- Reset currently removes the full storage key and clears in-memory secrets.
- Public docs source for the wizard is `apps/www/src/content/docs/docs/guides/self-hosting.mdx`.
- Relevant rule: `.claude/rules/01-doc-sync.md` for public self-hosting docs synchronization.
- Relevant rule: `.claude/rules/13-staging-verification.md` for mandatory staging verification for code PRs.

## Implementation checklist

- [x] Keep generated `webhookSecret` and `passphrase` in JavaScript memory only.
- [x] Remove generated secrets from the serialized `localStorage` payload.
- [x] Make `loadState()` drop legacy persisted generated secrets and rewrite/cleanup state.
- [x] Preserve restoration of step, furthest step, account type, and non-secret field values.
- [x] Preserve current same-tab wizard outputs and copy/reveal behavior.
- [x] Update misleading wizard copy to say generated values are available for the current tab/session, not restored from browser storage.
- [x] Add realistic canary tests proving generated secrets are absent after generation.
- [x] Add canary tests proving generated secrets are absent after reload while non-secret state is restored.
- [x] Add canary tests proving generated secrets are absent after save/navigation.
- [x] Add canary tests proving reset clears storage and memory outputs.
- [x] Add canary tests proving legacy-state migration removes `webhookSecret` and `passphrase` while preserving non-secret state.
- [x] Run mobile and desktop Playwright review for the public self-host wizard.
- [x] Run specialist reviews: `test-engineer`, `security-auditor`, `ui-ux-specialist`, `doc-sync-validator`, `task-completion-validator`.
- [x] Address reviewer findings.
- [x] Run relevant local quality suite.
- [x] Deploy and verify staging.
- [x] Open a targeted PR and wait for CI green; do not merge.

## Acceptance criteria

- Generated `GH_WEBHOOK_SECRET` and `PULUMI_CONFIG_PASSPHRASE` do not appear in `localStorage` after generation, step navigation/save, page reload, reset, or legacy-state migration.
- Non-secret wizard progress remains restorable from `localStorage`.
- Existing output values remain available in-memory during the current tab session.
- Legacy `sam-self-host-wizard-v1` payloads containing generated secret fields are cleaned up safely without losing non-secret progress.
- Misleading copy is corrected without changing the wizard’s public API, storage key, or non-secret payload format.
- Canary tests use recognizable secret values and fail if those values appear in persisted browser storage.
- Mobile and desktop Playwright review shows no layout regression or horizontal overflow.

## Local validation evidence

- `pnpm --filter @simple-agent-manager/www exec playwright test -c playwright.config.ts tests/playwright/self-host-wizard-secrets.spec.ts --reporter=list --workers=1` → 12 passed across desktop and mobile projects.
- Cloudflare Pages preview deploy: https://github.com/raphaeltm/simple-agent-manager/actions/runs/30992702046 → success for commit `60dedd82b8489e121045b6031f93f379f78748b3`; preview alias https://sam-keep-generated-self-host.sam-www.pages.dev.
- `PLAYWRIGHT_BASE_URL=https://sam-keep-generated-self-host.sam-www.pages.dev pnpm --filter @simple-agent-manager/www exec playwright test -c playwright.config.ts tests/playwright/self-host-wizard-secrets.spec.ts --reporter=list --workers=1` → 12 passed across desktop and mobile projects on deployed preview.
- `pnpm --filter @simple-agent-manager/www build` → passed.
- `pnpm exec prettier --check apps/www/public/scripts/self-host-wizard.js apps/www/playwright.config.ts apps/www/tests/playwright/self-host-wizard-secrets.spec.ts apps/www/package.json tasks/active/2026-08-05-self-host-wizard-memory-only-secrets.md` → passed.
- `pnpm lint` → passed with pre-existing warnings, 0 errors.
- `pnpm typecheck` → passed.
- `pnpm build` → passed.
- `pnpm test` → failed in unrelated `@simple-agent-manager/providers` Vultr lifecycle warning assertion (`tests/unit/vultr-lifecycle.test.ts`); targeted `apps/www` Playwright canaries passed.
- `pnpm --filter @simple-agent-manager/www exec tsc --noEmit` → failed on pre-existing unrelated `src/scripts/tracker.ts` nullable endpoint issues and Starlight dependency type resolution errors; `apps/www` production build passed.

## Local reviewer outcomes

- `test-engineer`: PASS. Canary tests are scenario-driven and cover generation, reload, save/navigation, reset, legacy cleanup, plus desktop/mobile visual checks.
- `security-auditor`: PASS. Generated secrets no longer serialize to `localStorage`; legacy persisted generated secrets are scrubbed; reset clears hidden output DOM/cache.
- `ui-ux-specialist`: PASS. Copy clarified without changing flow/layout; desktop/mobile Playwright screenshots and overflow checks passed.
- `doc-sync-validator`: PASS. Public self-host page copy updated; no env/API/public docs contract changes required.
- `task-completion-validator`: PASS. Implementation and test coverage match the task checklist and acceptance criteria; PR/staging/CI remain pending.

## PR evidence

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/1741 — open and explicitly marked DO NOT MERGE.
- Initial CI passed all code/test/build/review jobs, then Preflight Evidence failed because the PR body was missing the required hidden Agent Preflight block. PR body was corrected and this evidence commit retriggers CI with the corrected body.
