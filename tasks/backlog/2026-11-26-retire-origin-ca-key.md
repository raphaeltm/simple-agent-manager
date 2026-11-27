# Retire the legacy Origin CA key, CSR and certificate from Pulumi state

Decision D3, approved by Raphaël on 2026-11-26 (relayed by coordinator task 01M7XCE59V5X0WTNF1X3NFZP5J)
as a follow-up to `tasks/active/2026-11-26-installation-keys-out-of-pulumi-and-ci.md`.

## Problem

`infra/resources/origin-ca.ts` keeps a protected `tls.PrivateKey` `origin-ca-key`, its `tls.CertRequest`
`origin-ca-csr`, and a live 15-year `cloudflare.OriginCaCertificate` `origin-ca-cert` for
`*.BASE_DOMAIN` and `*.vm.BASE_DOMAIN`. `infra/index.ts` exports `originCaKeyPem`/`originCaCertPem`.
Its private key is therefore a key in Pulumi state, which the mandate ("if there are keys in Pulumi
state, I want them out") rules out. `.claude/rules/07-env-and-urls.md` says new VM nodes generate
their Origin CA keys locally and fetch certificates through the node-scoped callback, so the
shared certificate should be unused.

## Findings (2026-11-27)

- No code reads the shared certificate or key. Since #1413 (2026-07-01) cloud-init generates a
  node-local key and fetches a per-node certificate from `/api/nodes/:id/origin-ca-certificate`
  (`packages/cloud-init/src/template-ingress.ts`), with no fallback: a node that cannot get one
  refuses to start. Per-node issuance uses the Worker's own `CF_API_TOKEN`
  (`apps/api/src/services/origin-ca-certificates.ts`). `env.ts` declares `ORIGIN_CA_CERT`/
  `ORIGIN_CA_KEY`, but nothing reads them.
- Live nodes: production's two running nodes were created 2026-08-26 and 2026-11-27, after #1413.
  staging has none. staging2 has only Cloudflare containers, which use no origin certificate.
- Extra copies: `sam-api-prod` and `sam-api-staging` still hold `ORIGIN_CA_CERT` and `ORIGIN_CA_KEY`
  Worker secrets. staging2's Worker has neither.
- Per-node certificates use the same hostnames as the shared one (`buildOriginCaHostnames`), so a
  hostname match cannot identify the shared certificate. `pulumi stack --show-ids` is banned by
  the `state-export` guard (rule 83).

## Plan (coordinator decision, 2026-11-27)

- **PR-A:** add only the plain output `originCaCertificateId`. After it deploys, confirm the output
  holds a value on production and staging.
- **PR-B:** the retire step revokes exactly the recorded ID when `pulumi stack output
  originCaCertificateId` returns one. Without it (a fork that takes both releases at once), it falls
  back to listing the zone's Origin CA certificates and revoking only when exactly one has the CSR
  subject `CN=*.<BASE_DOMAIN>, O=Simple Agent Manager`; otherwise it logs the count and skips.
  First check that Cloudflare's list response includes the CSR.
- The revoke is skipped while the installation's D1 has a non-deleted node created before #1413;
  the state delete and the secret delete still run. The stale Worker secrets are deleted by name,
  idempotently. Keep `CF_ORIGIN_CA_KEY` for the revoke for now, and remove it in a later cleanup.
  Tests cover the ID path and the fallback path with 0, 1 and 2+ matches.

## Checklist

- [x] PR-A: plain output `originCaCertificateId`
- [x] Prove nothing uses the shared certificate: no script reads `originCaKeyPem`/`originCaCertPem`,
      no cloud-init or VM agent path reads `ORIGIN_CA_CERT`/`ORIGIN_CA_KEY`, and no live node (staging,
      staging2, production) still serves it. Check nodes' cert serials against the Pulumi cert's serial
      by name, never by exporting state.
- [ ] Remove the resources and outputs from the program; retire them by exact type+name with a
      controlled step like `scripts/deploy/retire-key-resources.ts` (extend its allowlist), excluded
      from previews and takeover gates.
- [ ] Revoke the certificate (outward-facing: confirm first that nothing uses it, then do it).
- [ ] Remove the `originCaKeyPem` exception in `infra/__tests__/secrets.test.ts`.
- [ ] Docs: rule 07, self-hosting guide.

## Acceptance criteria

- No private key or certificate of the shared Origin CA remains in the program, its outputs or the
  current state of staging, staging2 and production.
- The certificate is revoked, and VM nodes keep serving TLS with their own certificates.
