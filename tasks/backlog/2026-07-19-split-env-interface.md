# Split apps/api/src/env.ts Env Interface Into Domain Modules

## Problem

`apps/api/src/env.ts` crossed the 800-line mandatory-split ceiling (802 lines) during the 2026-07-19 instant-container hotfix (two added env var declarations tipped a file already sitting at the limit). A `FILE SIZE EXCEPTION` comment was added to unblock the outage fix; this task tracks the real split.

## Approach

The composition pattern already exists: `Env extends WebhookTriggerEnv, TaskRecoveryEnv`. Extract cohesive domains into their own interfaces (e.g. `CfContainerEnv`, `DeploymentEnv`, `ObservabilityEnv`, `AgentProxyEnv`) in sibling modules, extend them from `Env`, and remove the exception comment. Consumers keep importing `Env` from `./env` — no call-site changes.

## Acceptance Criteria

- [ ] `env.ts` under 500 lines; no `FILE SIZE EXCEPTION` comment
- [ ] All extracted interfaces re-exported through `env.ts`; zero consumer import changes
- [ ] `pnpm typecheck` + full test suite green
- [ ] `.env.example` groupings untouched (documentation-only file)
