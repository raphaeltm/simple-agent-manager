# Implement Encrypted Swap for SAM VMs

## Problem

SAM VM cloud-init currently creates and enables `/swapfile` directly. Swap can contain sensitive workspace data, so ephemeral VMs should avoid leaving recoverable plaintext swap contents on disk.

## Goal

Replace the current unencrypted swap activation with dm-crypt encrypted swap backed by `/swapfile`, using an ephemeral random key read from `/dev/urandom`. The key must never be persisted and is lost on VM shutdown.

## Research Findings

- `packages/cloud-init/src/template.ts` contains the production cloud-init runcmd swap block. It currently runs `fallocate`, `chmod 600`, `mkswap /swapfile`, `swapon /swapfile`, and appends `/swapfile` to `/etc/fstab`.
- `scripts/vm/cloud-init.yaml` is a reference copy of the production template and must mirror the swap setup for operator visibility.
- `packages/cloud-init/tests/generate.test.ts` already parses generated YAML and has a `swap file configuration` suite around the runcmd block and sysctl persistence.
- `packages/cloud-init/src/generate.ts` validates `swapSizeMb` and `swapSwappiness`. This task does not require new variables or validation changes.
- `.claude/rules/02-quality-gates.md` and `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md` require real VM provisioning verification for cloud-init changes.
- `.claude/rules/27-vm-agent-staging-refresh.md` says to delete existing staging nodes before validating changes that depend on newly provisioned VM state.

## Implementation Checklist

- [x] Update `packages/cloud-init/src/template.ts` to run `cryptsetup open --type plain --cipher aes-xts-plain64 --key-size 256 --key-file /dev/urandom /swapfile cryptswap` after `chmod 600 /swapfile`.
- [x] Change production cloud-init `mkswap`, `swapon`, and `/etc/fstab` entries to target `/dev/mapper/cryptswap`.
- [x] Update `scripts/vm/cloud-init.yaml` with the same encrypted swap setup.
- [x] Update `packages/cloud-init/tests/generate.test.ts` to assert `cryptsetup`, `/dev/mapper/cryptswap`, `--key-file /dev/urandom`, and `--cipher aes-xts-plain64` are present.
- [x] Ensure no new env vars, no new `CloudInitVariables` fields, and no validation logic changes.
- [ ] Run focused cloud-init tests and full repository quality checks. Focused cloud-init tests passed: `pnpm --filter @simple-agent-manager/cloud-init test` (162 tests).
- [ ] Deploy to staging, delete existing nodes before testing, provision a fresh VM, and verify active swap is `/dev/mapper/cryptswap` with cipher `aes-xts-plain64`.

## Acceptance Criteria

- Generated cloud-init encrypts swap via dm-crypt with an ephemeral `/dev/urandom` key.
- Generated cloud-init never enables `/swapfile` directly as swap.
- Reference cloud-init YAML matches the production template behavior.
- Tests prove the encrypted swap command, key source, cipher, and mapper device are present.
- Staging verification on a freshly provisioned VM shows:
  - `swapon --show` lists `/dev/mapper/cryptswap`, not `/swapfile`.
  - `dmsetup table cryptswap` reports `aes-xts-plain64`.
  - Swap is active and functional.

## References

- SAM idea ID: `01KSK14P9CNS82MRVETGJMDY66`
- SAM task ID: `01KSK1RMD2DF9WZSMW3ACQSVZH`
- `packages/cloud-init/src/template.ts`
- `packages/cloud-init/src/generate.ts`
- `packages/cloud-init/tests/generate.test.ts`
- `scripts/vm/cloud-init.yaml`
- `.claude/rules/27-vm-agent-staging-refresh.md`
- `.claude/rules/02-quality-gates.md`
- `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`
