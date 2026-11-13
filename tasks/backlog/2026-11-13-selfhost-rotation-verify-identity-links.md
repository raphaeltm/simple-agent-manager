# Self-host rotation: report node fingerprints and credential mirrors that lost their pair

## Problem

Review V1 L6 on #2705. Two interleavings lose identity (never data) during `rotate encryption-key`:

- A node's `placement_credential_fingerprint` written from a credential read just before a migrate
  batch (`node-provisioning.ts`) misses the remap (`selfhost/key-rotation/d1-pass.ts`
  `writeStatements`). Strict teardown then refuses that node.
- An app write that copies a mirror's ciphertext from a pre-batch read is re-encrypted separately
  later, so `cc_credentials` and `credentials` no longer hold the identical pair.

Both fail closed (teardown refuses rather than deleting the wrong server), but nothing reports them.

## Context

Found by review V1 (PR #2705 comment, idea 01M77AG90EQB4F9VAKDVH94ZK4). LOW. Not done in F1: a
check needs an explicit mirror linkage (today mirrors are paired only by equal ciphertext) and a
fingerprint scan over every live node and credential.

## Proposed fix

The verify pass (or the control `status` op) reports, by id, live nodes whose fingerprint matches
no stored provider credential and mirror rows whose pair differs from their primary; the rotation
summary lists them so the operator can replace those nodes.

## Acceptance criteria

- [ ] Both interleavings reproduced on a real SQL engine and reported by id
- [ ] No report when nothing raced (control)
