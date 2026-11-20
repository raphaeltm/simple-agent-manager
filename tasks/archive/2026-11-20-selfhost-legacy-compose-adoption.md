# Self-host: adopt pre-L24 legacy compose installs so they can upgrade

Idea: 01M7VRD7FTD50WANT5FKWQS678. Coordinator: task 01M7JMXS2JRW6QQMB1356ENPM3.

## Problem

The post-merge combined L23+L24 smoke on sam-box (2026-11-20, checkout 7f086c72b) found that
every install created before L24 (#2918) cannot upgrade to main:

- main's `pnpm selfhost:upgrade` refuses it before any mutation: without `COMPOSE_PROJECT_NAME`,
  "missing installation compose creation receipt"; with `sam-selfhost`, "legacy shared compose
  project cannot safely roll back" (`scripts/selfhost/upgrade-preflight.ts:assertRollbackReady`).
- The pre-L24 tool on the box would check out main, whose `docker-compose.yml` requires
  `COMPOSE_PROJECT_NAME`, and it takes no backup.
- The README asks for an "operator-controlled migration" but gives no procedure.

## Research findings

- `recordInstall` (install-record.ts) already writes the compose-project receipt when
  `COMPOSE_PROJECT_NAME` equals the canonical name (`expectedComposeProjectFor`).
- The canonical name hashes the domain, state dir and `SAM_INSTALLATION_ID` (platform-keys.json).
- L24 treats `celld-data` as a disposable cache (backup-recovery.ts removes it on recovery).
- `runRollback` requires receipts and refuses legacy installs, so legacy rollback needs its own
  path. Adoption changes no code and deploys nothing, so legacy rollback never restores the bucket.
- The first hop from a pre-L24 checkout must run the new tool: the operator checks out the new
  ref, and the tool checks out the deployed `--from` ref while it adopts (the running stack's bind
  mounts and compose config must match), then chains into the normal L24 `runUpgrade` from it.
- The box (.tmp/legacy-layout.txt): 4 volumes `sam-selfhost_{caddy-config,caddy-data,celld-data,
egress-fence-attestation}`, 8 containers (including the one-shot `celld-data-owner` and
  `caddy-volumes`), all labelled working_dir/config_files/environment_file in /home/sam/sam.
- upgrade-lib.ts is at 493 lines (rule 18), so adoption lives in new modules.

## Checklist

- [x] `--adopt-legacy --from <full sha>` on `selfhost:upgrade` (upgrade.ts), operator-only
- [x] Ownership proof: every container in the legacy project is labelled with this checkout's
      working dir, compose files and env file; bind mounts sit inside the checkout or state dir;
      each legacy volume is mounted only by proven containers; the running config hash equals
      `--from`'s compose config; there is exactly one running celld; the canonical project is empty
      (or exactly what this journal created). Anything else refuses.
- [x] Backup first (runBackup against the explicit legacy project) before any change
- [x] Durable private journal (`.state/legacy-adoption.json`) plus a private copy of the original
      .env; resume after a kill at every phase; a killed copy helper is removed before re-copy
- [x] Copy each volume into a labelled canonical volume; verify by a content, mode and owner digest
- [x] Set `COMPOSE_PROJECT_NAME`, start the canonical project, verify health, write receipts via
      `recordInstall`, remove the stopped legacy containers, keep the legacy volumes (print rm command)
- [x] Failure or failed verify rolls back to the legacy project: canonical containers and owned
      volumes removed, .env restored byte for byte, canonical celld cache copied back if it ran,
      legacy stack started and health-checked
- [x] Chain into `runUpgrade` from `--from`; keep the journal until the upgrade succeeds
- [x] README: legacy adoption procedure, resume and rollback behaviour
- [x] Live real-Docker tests: adopt-then-upgrade (the L24 preflight passes afterwards), kill
      mid-copy then resume, ambiguous-ownership refusal (another checkout on the same project),
      failed verify rolls back to legacy; plus unit tests for argument and journal validation
- [x] Box adoption from the PR head before merge (this feature's staging gate, per the
      coordinator): PASS at 80cce88ea on 2026-11-20 06:27-06:33 UTC, evidence in PR #2932. The
      post-merge upgrade to main and the forced-verify rollback belong to the original smoke
      task 01M7VQQR2VBF219A7MJWMAWSZA (combined L23+L24 smoke), which reports them to the
      coordinator; they are not gates of this task.
- [x] Security review (security-auditor PASS: 3 MEDIUM and 4 LOW fixed in the second commit)

## Acceptance criteria

- On a legacy fixture, adoption succeeds and `assertRollbackReady` then passes; data survives.
- A kill during a volume copy resumes to a verified complete copy.
- A legacy project also used by another checkout is refused with no change.
- A failed health verification leaves the legacy project running, its data and .env unchanged.
- sam-box is adopted from the PR head and upgraded; data survives (PASS). Smoke steps 1, 2 and 4 on
  main are the smoke task's, after merge.

## Outcome

- PR #2932. Box gate PASS at 80cce88ea:
  - the box was adopted into `sam-selfhost-0453bcf9d4e3`;
  - the chained upgrade was healthy;
  - hosted-git, sign-in and projects survived;
  - the fence is in effect.
- Codex raised four P1s on that head; all are fixed in f98892c1f with discriminating real-Docker or unit tests.
- Reviews: security PASS (plus delta reviews), task-completion and doc-sync addressed.
