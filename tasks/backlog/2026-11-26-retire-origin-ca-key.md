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

## Checklist

- [ ] Prove nothing uses the shared certificate: no script reads `originCaKeyPem`/`originCaCertPem`,
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
