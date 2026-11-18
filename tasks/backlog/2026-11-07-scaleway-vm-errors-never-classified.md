# Scaleway VM-path errors never reach `classifyScalewayError`

## Problem

`classifyScalewayError` (`packages/providers/src/scaleway.ts`) is called only from
`ScalewayProvider.mapProviderError`, and that mapper is wired only into `ScalewayVolumeClient`
(`scaleway.ts:168`, `scaleway-volumes.ts:104`). `createVM`, `deleteVM`, `listVMs` and the power
operations never call it. Every Scaleway VM error therefore reaches the TaskRunner as
`category: 'unknown'`, so a Scaleway out-of-stock error fails the task on its first offering
instead of descending the pool's fallback chain. GCP had the same bug, fixed in
`tasks/active/2026-11-07-gcp-create-error-classification.md`.

The classifier also maps a bare HTTP 503 to `transient_capacity` (`scaleway.ts:88`). On a create
POST, a 503 does not prove that no server was created. `transient_capacity` makes the TaskRunner
delete the node row and create on another offering, which can leave a ghost VM and bill twice
(TLA+ path P2, idea `01M6NXTF2RQ5QXHM7YZ4ZF0XBK`).

## Context

Found by the architecture reviewer during PR 1 of the provider-priority work (2026-11-07), and
confirmed by grep.

## Acceptance criteria

- [ ] Scaleway VM create errors carry a category assigned at construction (rule 72).
- [ ] A bare 503 on create is not `transient_capacity` unless Scaleway's body proves an
      out-of-stock condition.
- [ ] Provider tests drive the real `ScalewayProvider.createVM` with fresh responses per call and
      assert the parsed message and code.
- [ ] An action-layer test shows a Scaleway out-of-stock error descending the fallback chain, plus
      a control showing an auth failure fails fast.
