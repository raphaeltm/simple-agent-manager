# Fix VM-001 Origin CA Private Key in Cloud-Init

## Problem

Newly provisioned nodes currently receive the platform-wide Cloudflare Origin CA private key in static cloud-init user-data. A single compromised VM, provider snapshot, or metadata leak can expose key material that is valid for TLS across the fleet.

## Constraints

- Do not merge.
- Do not deploy to staging.
- Do not provision real VMs.
- Stop at a draft PR labeled `needs-human-review`.
- Human owns staging, real VM provisioning, and TLS handshake verification.

## Research Findings

- `infra/resources/origin-ca.ts` creates one long-lived wildcard Origin CA certificate/key pair for `*.${BASE_DOMAIN}`, `*.vm.${BASE_DOMAIN}`, and `${BASE_DOMAIN}`.
- `apps/api/src/services/nodes.ts` passes `env.ORIGIN_CA_CERT` and `env.ORIGIN_CA_KEY` into `generateCloudInit()`.
- `packages/cloud-init/src/template.ts` writes `/etc/sam/tls/origin-ca.pem` and `/etc/sam/tls/origin-ca-key.pem` into static user-data.
- `packages/cloud-init/tests/generate.test.ts` already parses YAML for PEM round-trip tests, which matches Rule 02 template-output verification.
- Node callback JWTs are node-scoped (`signNodeCallbackToken()` in `apps/api/src/services/jwt.ts`) and existing node routes reject tokens for the wrong node.
- Cloudflare Origin CA API supports creating a certificate from caller-provided CSR, wildcard hostnames, `origin-rsa`, and validity values of 7, 30, 90, 365, 730, 1095, or 5475 days.

## Approach

Use per-node key material generated on the VM at first boot:

- Cloud-init creates the private key locally with OpenSSL.
- Cloud-init creates a CSR locally.
- Cloud-init calls a new node-scoped callback-auth endpoint to sign the CSR through Cloudflare Origin CA.
- The endpoint returns only the certificate, never the platform-shared private key.
- The cert remains wildcard-scoped for compatibility with existing `ws-*` routing, but each node has a distinct private key and signed cert that can be revoked independently.

Tradeoff: this still relies on wildcard hostnames because existing workspace subdomains are not node-specific. It removes the static user-data exposure and fleet-wide private-key reuse, but full hostname minimization would require routing/certificate model changes for workspace hostnames.

## Checklist

- [x] Remove static Origin CA private key/certificate embedding from cloud-init template generation.
- [x] Add boot-time per-node key and CSR generation in cloud-init.
- [x] Add node-scoped Origin CA CSR signing API route.
- [x] Wire provisioning to pass only the certificate retrieval URL/metadata needed by cloud-init.
- [x] Add cloud-init YAML parsing tests that prove static user-data does not contain the private key.
- [x] Add authz tests proving a token from another node is rejected by the CSR signing endpoint.
- [x] Add service tests for Cloudflare Origin CA request payload and error handling.
- [x] Update self-hosting and security architecture docs with the new cert model and existing wildcard-key rotation path.
- [x] Run local quality checks and specialist review.
- [ ] Open draft PR with `needs-human-review`; do not deploy, provision VMs, merge, or mark ready.

## Acceptance Criteria

- [x] New nodes no longer carry the shared Origin CA private key in static cloud-init user-data.
- [x] Cloud-init output is parsed in tests and asserted not to contain the private key.
- [x] Node-scoped retrieval/signing endpoint rejects a token from a different node.
- [x] Rotation path for the existing broadly distributed wildcard key is documented.
- [x] Self-hosting and security architecture docs reflect the new cert model.
- [x] Staging/real TLS verification is explicitly left for human review.

## References

- SAM task: `01KVZGM1B109J2RB9T178V3Z27`
- Idea: `01KVZGJD7XSBNFQ02D8X91SQPA`
- Library doc reference: `/security/SAM-security-review-master-local.md` fileId `01KVZC43FR37A78WZNAMX29Q1S`, Domain C
- Rules: `.claude/rules/01-doc-sync.md`, `.claude/rules/02-quality-gates.md`, `.claude/rules/22-infrastructure-merge-gate.md`, `.claude/rules/27-vm-agent-staging-refresh.md`
