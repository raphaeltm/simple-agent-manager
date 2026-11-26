# CI secret-handling audit: remaining risks

Found by the audit of every workflow and the scripts they call for SAM task
01M7M4PMFV7ATSA5GJNXGKCXDT (policy 795e72a6, `.claude/rules/83-no-secret-readback-in-ci.md`).
None of these prints a secret today. Each leaves a value GitHub may not mask in runner memory,
on a command line or in a file, where one future `echo` or error path would print it. The
staging2 bootstrap, the `configure-secrets.sh` readback (tracked separately in
`tasks/archive/2026-11-17-remove-pulumi-secret-readback.md`), `set -x` and the raw
registry-credential dump were fixed in that task.

## Findings

1. **Shared-engine secret bundle** (`.github/workflows/deploy-reusable.yml`, "Deploy with Shared
   Engine (opt-in)"): every secret goes into `SAM_CI_SECRETS_JSON` through `toJSON(secrets.X)`.
   A JSON-escaped PEM (`GH_APP_PRIVATE_KEY`, `JWT_PRIVATE_KEY`, `DEPLOY_SIGNING_PRIVATE_KEY`) is
   one `\n`-joined line, a form GitHub may not match. Today `installer-engine-ci-cli.ts` deletes
   the variable before it starts subprocesses, and `installer-engine.ts` withholds output tails.
   The path is opt-in and staging-only.
2. **`setup-token.ts` mask under the shared engine**: `::add-mask::` goes to the stdout of a
   subprocess whose output is piped, so the mask is never registered.
3. **Bearer tokens on curl command lines**, visible in the process list:
   - teardown.yml (19)
   - teardown-www.yml (4)
   - provision-www.yml (3)
   - pulumi-state-repair.yml (2)
   - deploy-reusable.yml (1)
   - configure-ai-gateway.sh (2)
   - configure-d1-read-replication.sh (2)
   - configure-r2-cors.sh (1)
   - verify-pages-domain.sh (3)

   Pass them in a header file or with `-H @file` instead of an argument.
4. **devcontainer-cache-experiments.yml**:
   - The R2 keys are put into `CACHE_ARGS` on the `docker buildx` command line, and that
     output is `tee`'d to the log.
   - `wrangler containers push` output is `tee`'d unredacted.
   - The minted `REGISTRY_PASSWORD` is written to `$GITHUB_ENV`, so every later step in the
     job has it (it is masked).
5. **Installer OAuth `client_secret`** (`apps/installer/scripts/deploy.mjs`): minted in
   deploy-installer.yml and never masked. It is not printed today.
6. **`RandomId` resource ids** hold raw key bytes in Pulumi state, and a replace could show them in
   `pulumi preview --diff` or `pulumi up`. This is covered by
   `tasks/archive/2026-11-17-remove-pulumi-secret-readback.md`.

## Checklist

- [ ] 1 and 2: pass shared-engine secrets one by one through env, not a JSON bundle, and register
      masks in the parent process
- [ ] 3: move bearer tokens off curl command lines
- [ ] 4: R2 cache credentials through a BuildKit secret or env, not a command-line string;
      redact or drop the `tee` of push output; scope the registry password to one step
- [ ] 5: mask the minted client secret right after it is created
- [ ] Extend `pnpm quality:no-secret-readback` if any of these turns out to have a mechanical
      signature with low noise (for example `Authorization: Bearer $` inside a curl argument)

## Acceptance criteria

- No secret travels on a command line, in a JSON bundle or through `$GITHUB_ENV` in these paths.
- `pnpm quality:no-secret-readback` stays green.
