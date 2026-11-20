# Self-host: restore keeps the egress fence rules readable

Idea: 01M7VZV7KAHHHQYACHBJB96R2K. Coordinator: task 01M7JMXS2JRW6QQMB1356ENPM3.

## Problem

The combined L23+L24 smoke (step 4, 2026-11-20 08:00 UTC) forced an upgrade verify failure on the
box. L24's automatic rollback then failed:

- The snapshot restore writes every state file 0600, because the encrypted inventory keeps only
  the exec bit (`backup-encryption.ts`).
- The egress-fence container reads `.state/egress-fence.nft` as root without `DAC_OVERRIDE`.
  It got "Permission denied" and crash-looped, so celld never started.
- The documented retry repeated the same restore. `deploy --init` could not repair the mode either,
  because `writeFenceFiles` only writes or chmods when the content changed.

## Audit

- Bind mounts from the state dir into containers (`docker-compose.yml`): only `egress-fence.nft`.
  The `env_file` entries (celld.env, gateway.env, mail-collector*.env) are read by the Compose CLI
  as the operator, so 0600 is correct for them.
- Writers: `fence-state.ts` (deploy, 0644 only on change), `backup-restore.ts:restoreBackup`
  (fresh restore), `backup-recovery.ts:runRollback` (upgrade auto-rollback, manual rollback and
  the rollback-state swap). Legacy adoption rollback writes only `.env` and its own journal,
  operator-private by design.

## Checklist

- [x] `fence-state.ts`: `FENCE_RULES_FILE`/`FENCE_RULES_MODE` and `repairFenceRulesMode`. It
      touches only a regular file the operator owns and refuses symlinks.
- [x] `writeFenceFiles` repairs the mode when the content is unchanged (so `deploy --init` self-heals).
- [x] `runRollback` and `restoreBackup` repair the mode after writing state (old snapshots too).
- [x] Tests:
  - real-Docker restore, then a capability-dropped root reads the rules (fails on main with
    "Permission denied");
  - `runRollback` restores 0644;
  - deploy repairs unchanged content;
  - symlink refusal;
  - secrets stay 0600.
- [x] README: restore mode exception and fence recovery note.
- [x] Box proof before merge: PASS (2026-11-20 08:19–08:26 UTC). The box was upgraded main →
      7ba650f2c; then, from that head, an upgrade to main with a forced verify failure ran.
      "automatic rollback completed" with no manual chmod: back on 7ba650f2c, rules 0644,
      journal clean, fence healthy, health 200, data intact (evidence in PR #2934).

## Acceptance criteria

- A rollback on a fenced install completes and the fence stays healthy (box proof).
- No secret-bearing file is loosened.
