# Remove the Pulumi secret readback from configure-secrets.sh

Tracked by policy 795e72a6 (no secret readback in GitHub Actions) and
`.claude/rules/83-no-secret-readback-in-ci.md`. Parent work: SAM task 01M7M4PMFV7ATSA5GJNXGKCXDT.

## Problem

`scripts/deploy/configure-secrets.sh` (`read_pulumi_secret`) runs
`pulumi stack output <name> --show-secrets` on every deploy, production included, for six
Pulumi-generated values: `encryptionKey`, `jwtPrivateKey`, `jwtPublicKey`,
`deploySigningPrivateKey`, `previewSigningKey`, `vapidPrivateKeyPem`. It then copies them into
Worker secrets with `wrangler secret bulk`. These values are not GitHub secrets, so GitHub does
not mask them on its own. Since 2026-11-17 every value is registered with `::add-mask::` (every line and the
JSON-escaped form) immediately after the read, and the read carries a
`sam:secret-readback-allowed` marker naming this task, so `pnpm quality:no-secret-readback`
accepts it. That is a stopgap. The policy says the runner should not hold these values at all.

Related exposure found in the same audit: `infra/resources/secrets.ts` generates these keys
with `random.RandomId`, whose resource `id` is the raw key in base64url and is stored in plain
text in Pulumi state. A replace shown by `pulumi preview --diff` or `pulumi up` could print it,
and GitHub would not mask it.

## Design options

1. **Set once, never read back (recommended).** Worker secrets persist across deploys. The
   deploy lists the Worker's secret names (`wrangler secret list` returns names only), and
   writes a key only when its name is missing. A brand-new installation does need one first
   write. That write happens inside Pulumi: a Pulumi-managed Cloudflare Worker secret resource,
   or a Pulumi `command` resource whose input is the secret output. Either way the value travels
   Pulumi → Cloudflare API and never reaches the shell. Routine deploys then hold no key at all.
   Recovery: the key stays in Pulumi state, so a lost Worker secret is restored by a human
   running the read on their own machine, not in Actions.
2. **Keys as GitHub secrets.** Raphaël copies each production key into the `production`
   Environment once, by hand. Deploys then take it from `secrets.*`, so GitHub masks it, and
   pass it straight to `wrangler secret bulk`. The precedence for this exists today
   (`SECRET_ENCRYPTION_KEY` and the others), so the change is mostly configuration plus deleting
   `read_pulumi_secret`. Cost: a manual step for every installation, including self-hosted
   forks, which goes against the "generated platform secrets" principle in
   `.claude/rules/07-env-and-urls.md`.
3. **Derived public keys from a public output.** `jwtPublicKey` is public. Pulumi could export
   the public halves as non-secret outputs, so only private material needs option 1 or 2.

Do not change production key values or rotate anything without asking Raphaël. Changing
`ENCRYPTION_KEY` makes every stored credential undecryptable.

## Checklist

- [ ] Decide between options 1 and 2 with Raphaël
- [ ] Remove `read_pulumi_secret` / `load_pulumi_secret` and the `sam:secret-readback-allowed`
      markers in `scripts/deploy/configure-secrets.sh`
- [ ] Remove the allowlist entry this task backs from `pnpm quality:no-secret-readback`
- [ ] Stop `RandomId` resource ids carrying raw key bytes (for example `random.RandomBytes`
      with a secret output), without changing any existing key value
- [ ] Deploy staging, staging2 and production; check in the logs that no Pulumi secret is read
- [ ] Update `apps/www/src/content/docs/docs/guides/self-hosting.mdx` if the setup changes

## Acceptance criteria

- No deploy job reads a Pulumi secret output or holds a generated key in shell memory.
- Existing installations keep their keys (stored credentials still decrypt after deploy).
