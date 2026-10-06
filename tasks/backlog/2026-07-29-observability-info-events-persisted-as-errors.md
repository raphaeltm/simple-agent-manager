# Stop persisting ACP lifecycle info events as platform errors

## Problem

The staging observability-noise gate on 2026-07-29 reported repeated informational ACP lifecycle messages in `platform_errors`, including “ACP Prompt started/completed”, “Agent selection started”, credential/binary readiness, initialize/new-session success, and “SessionHost stopped”. Counts ranged from 16 to 35 in the preceding 24 hours and caused `pnpm quality:observability-noise` to fail.

## Evidence

- Environment: staging (`sam-observability-staging`)
- Gate: `CF_ACCOUNT_ID=... OBSERVABILITY_DB_ID=... pnpm quality:observability-noise`
- 11 medium-severity repeated-error findings
- Workers telemetry portion was unavailable with the current read token (403), but persisted D1 evidence was conclusive.

## Acceptance criteria

- Informational ACP lifecycle events are emitted at info/debug severity and are not persisted into `platform_errors` as error rows.
- Genuine ACP failures remain persisted with error severity.
- Add a regression test covering the structured/instrumented logger boundary.
- `pnpm quality:observability-noise` passes on staging after deployment and an appropriate observation window.
