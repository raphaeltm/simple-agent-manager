---
paths:
  - '.github/workflows/**'
  - 'scripts/deploy/**'
  - 'scripts/ci/**'
  - 'infra/**'
  - 'scripts/quality/check-no-secret-readback.ts'
---

# No Secret Readback or Printing in CI

## When This Applies

Any change to a workflow, a deploy or CI script, or Pulumi code that touches a secret: a
GitHub secret, a Pulumi secret output, a Worker secret, a stored credential, or any value
derived from one.

## Why This Rule Exists

Raphaël, 2026-11-17 (project policy 795e72a6): "Make sure we never do anything ever again that
even has the slightest risk of printing secrets in github actions. Better to just have me do
some manual work configure a new environment if necessary, or ask me to give you a secret in
here that you can add to github action secrets."

The staging2 bootstrap ("Bootstrap Secondary Installation" in
`.github/workflows/deploy-reusable.yml`) read both installations' `ENCRYPTION_KEY` with
`pulumi stack output --show-secrets` on every deploy. It decrypted staging's platform
credentials (the Claude Code key, the cloud credential, test accounts' GCP keys), re-encrypted
them for staging2, HMACed the smoke token with the target key, and derived staging2's sign-in
trust from staging's secret. `scripts/deploy/configure-secrets.sh` read six Pulumi-generated
keys the same way on every deploy, production included, and masked none of them. A scan of
the logs found no leak. The design was rejected anyway: GitHub masks only values it knows,
line by line, so a value read back, decrypted, JSON-escaped, base64-encoded or derived is not
masked, and one stray `echo`, `set -x` or error message prints it.

## Hard Requirements

1. **No readback.** Never read a secret out of Pulumi (`--show-secrets`, `showSecrets: true`,
   `pulumi config get` of a secret), out of a Worker, or out of D1 in a runner.
2. **No decryption in CI.** Never decrypt stored credentials (`platform_credentials`, user
   credentials) in a workflow or deploy script, and never import a decrypt helper there.
3. **No copying between installations.** An installation never takes another installation's
   credentials. Staging installations do not share credentials automatically.
4. **No tracing or dumps.** No `set -x` (in any flag cluster such as `set -euxo`), no `bash -x`.
   Never print `env`, `printenv`, or any variable or command output that can hold a secret,
   including to `$GITHUB_STEP_SUMMARY`, `$GITHUB_OUTPUT`, step outputs or artifacts.
5. **The only allowed shape:** a secret comes from `${{ secrets.X }}`, which GitHub masks, and
   goes straight to the tool that consumes it, through `env:` or stdin. It must never be a
   command-line argument, and it must never be transformed first.
6. **When an installation needs a secret or credential:** ask Raphaël to configure it by hand
   (Admin → Credentials, the Cloudflare dashboard, GitHub settings), or collect it in chat with
   `request_secret` and store it as a GitHub secret. Never print it. Prefer manual setup to
   automation that touches secret values.
7. **Legacy reads that cannot go yet** add `::add-mask::` for every line and for the
   JSON-escaped form, right after the read and before any other use, and only when
   `GITHUB_ACTIONS=true`. Each one carries `# sam:secret-readback-allowed <open task file>`
   and has a tracked task to remove it (rule 42).

## Enforcement

- **Mechanical, blocking in CI:** `pnpm quality:no-secret-readback`
  (`scripts/quality/check-no-secret-readback.ts`) reports Pulumi readback (`--show-secrets`,
  `showSecrets`, `pulumi config get`), credential decryption and decrypt-helper imports, shell
  tracing and environment dumps in `.github/`, `scripts/` and `infra/`. It accepts a marked line
  only when the file and task are pinned in its `ALLOWED_LEGACY_READS` and the task is still
  open. Coverage and noise measurements are in `scripts/quality/README.md`.
- **Judgment, in review:** printing a variable that holds a secret, transformed secrets (base64,
  JSON, HMAC or derived keys), secrets in step outputs, summaries or artifacts, and secrets on
  command lines. The check cannot tell which variables are secret.

## Quick Compliance Check

- [ ] No secret is read back, decrypted, derived or copied in a runner
- [ ] Every secret in a step comes from `secrets.*` and goes straight to its consumer, via env or stdin
- [ ] No `set -x`, environment dump, or echo of a secret-bearing variable or command output
- [ ] Manual setup steps for a new environment are written down for Raphaël rather than automated
- [ ] Any remaining legacy read is masked first and carries a marker naming an open task
- [ ] `pnpm quality:no-secret-readback` passes
