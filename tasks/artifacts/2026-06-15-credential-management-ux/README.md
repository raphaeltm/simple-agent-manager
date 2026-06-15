# Credential Management UX Visual Evidence

Playwright command:

```bash
pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/connections-ui-audit.spec.ts tests/playwright/settings-credentials-audit.spec.ts --grep "Normal|Codex"
```

Result: 36 passed across iPhone SE `375x667`, iPhone 14 `390x844`, and desktop `1280x800`.

Representative committed screenshots:

| Scenario                                     | Mobile                                                             | Desktop                                                               |
| -------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Connections overview with direct row actions | [mobile](./connections-normal-dark-375-375x667.png)                | [desktop](./connections-normal-dark-1280-1280x800.png)                |
| Codex auth.json happy path                   | [mobile](./connect-flow-codex-auth-json-dark-375-375x667.png)      | [desktop](./connect-flow-codex-auth-json-dark-1280-1280x800.png)      |
| Replace active Codex credential              | [mobile](./connections-codex-replace-dark-375-375x667.png)         | [desktop](./connections-codex-replace-dark-1280-1280x800.png)         |
| Disconnect active Codex credential           | [mobile](./connections-codex-disconnect-dark-375-375x667.png)      | [desktop](./connections-codex-disconnect-dark-1280-1280x800.png)      |
| Invalid Codex auth.json validation           | [mobile](./connections-codex-broken-validate-dark-375-375x667.png) | [desktop](./connections-codex-broken-validate-dark-1280-1280x800.png) |
| Broken config recovery via replace           | [mobile](./connections-codex-broken-replace-dark-375-375x667.png)  | [desktop](./connections-codex-broken-replace-dark-1280-1280x800.png)  |
| Advanced typed primitive CRUD                | [mobile](./settings-credentials-normal-dark-375-375x667.png)       | [desktop](./settings-credentials-normal-dark-1280-1280x800.png)       |

The full successful run also generated light-theme and `390x844` screenshots under `apps/web/.codex/tmp/playwright-screenshots`; only the representative dark-theme artifacts above are committed to keep the PR small.
