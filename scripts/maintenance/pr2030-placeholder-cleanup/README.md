# PR 2030 staging placeholder proof repair

This isolated maintenance branch starts at `708e4f179aab3d9ee66c8f0dfe5e73eb5c856eb1`.
It must **never be merged into main or PR 2030**: its registered
`.github/workflows/deploy-staging.yml` path intentionally contains only the
maintenance job, with no application deployment or smoke-test jobs.

## Scope and provenance

The exact workspace `01M20BZ3SP1ME6HDS6R4WTA6SB` failed in Hetzner placement
with HTTP 412 before any runtime attachment. Its original observation at
`2026-09-08T11:21:00.349222+00:00` recorded workspace `error`, null node,
failed task `01M20BZ3YM6VA2B6NH82P65B21` at `workspace_creation`, and empty
node/snapshot results. The original `/tmp/pr2030-staging/final-fsn1-placement-failure.json`
was reduced to `original-evidence.json`; that file also records the SHA-256 of
the original observation. Unrelated task data and reservation details are omitted.

A DELETE made before the corrected deployment left this placeholder `stopping`
without its cleanup proof. The prepared local repair
`/tmp/pr2030-staging/repair-failed-placeholder.py` was not successfully executed:
the local credential rejected D1 writes. This workflow uses the existing
protected `staging` environment's `secrets.CF_API_TOKEN` and
`secrets.CF_ACCOUNT_ID`, exactly as `deploy-reusable.yml` does. Credentials are
consumed only by the Cloudflare HTTPS client; they are never printed or exported.

This is a one-row incident repair, not a new general cleanup policy. The audited
original no-runtime observation supplies evidence that cannot be inferred from
arbitrary failed/null-node workspaces. The corrected deployed application now
persists such cleanup proof at the time authoritative provisioning cleanup occurs.

## Mandatory guards

The script checks both GitHub `vars.BASE_DOMAIN` and the live Worker `BASE_DOMAIN`
are `sammy.party`; the live `sam-api-staging` Worker must bind `DATABASE` to
`1cfaf5d4-8226-47d8-bf26-6ba727ce5718` and report `VM_AGENT_REQUIRED_VERSION` equal
to the full base commit above. It repeats these Worker checks just before writing.

The real D1 SELECT and atomic UPDATE both require the exact workspace/user/project/
session identity, `stopping`, null node/server/IP, zero workspace compute usage,
zero workspace-or-session snapshots, and the exact task/user/project/session still
failed at `workspace_creation` with the recorded provider 412 and no provisioned
node. Other workspaces' nodes, usage, and snapshots are outside this repair.

The UPDATE only sets `workspace_never_started`, its confirmation timestamp, and
`updated_at`. Both proof fields must previously be null. A matching existing proof
with a nonempty timestamp, while all other guards still hold, returns
`already_proven` with zero writes. Conflicting/incomplete proofs refuse execution.
The post-read must match the original row except for the two proof fields.

## Operator procedure (requires root review before commit/push/run)

1. Review the four files in this directory and the workflow diff in the isolated
   worktree. Commit only this maintenance branch after approval; do not merge it.
2. After explicit authorization to push/run, push this branch and dispatch the
   already registered `deploy-staging.yml` workflow with this exact branch ref,
   leaving `apply=false` for a read-only preview.
3. Inspect the sanitized `preview_eligible` audit in logs/step summary and ensure
   it names only the intended staging placeholder and corrected Worker.
4. Dispatch the same branch with `apply=true`. Require `proof_persisted`, changes 1,
   and the verified proof/timestamp. An explicit retry may return `already_proven`,
   changes 0. No network/UPDATE retry is automatic.
5. Use the normal authenticated staging workspace DELETE API to finish deletion;
   this workflow does not delete the row or call that API. Verify the normal API's
   deletion result and absence of any owned runtime/usage left behind.
6. Retain the nonsecret workflow audit with the incident evidence, then remove the
   temporary branch/worktree after the root finishes verification.

Concurrency uses `deploy-staging`, matching normal deployments. This prevents
normal staging workflow overlap; it cannot fence out-of-band Worker mutations.
Coordinate any such operators separately. Any ambiguous network/post-write error
requires inspecting the exact row before an explicit rerun.

## Local validation and preflight

Classification: security-sensitive operational/infra change. Existing deployment
credential/environment wiring and the original incident record were inspected.
No new secret, environment prerequisite, production policy, public interface,
application deployment, or database migration is introduced. Fixed identities are
intentional incident-specific bounds, not application defaults. The replacement
workflow and this README remain only on the temporary maintenance branch.

Run the offline real-SQL guard scenarios without credentials or network:

```sh
python3 -m unittest discover -s scripts/maintenance/pr2030-placeholder-cleanup -p 'test_*.py' -v
```

Ten scenario tests cover preview/apply/idempotency, original evidence, live binding
mismatch, every identity/runtime/task guard, usage/snapshot rejection, unrelated
rows, conflicting proofs, and ownership/snapshot changes between SELECT and UPDATE.
