# Pulumi generated secret output annotations

## Problem and scope
Four secret RandomId resources annotate stack exports but not provider outputs. Add secret metadata without changing names, inputs, provider, protection or generated values. No exposure is confirmed. Existing SAM draft 01M4SRS8D3C7CNRMYG0Y46QXDR has no session, branch or PR; this task implements its annotation scope.

## Research
- infra/resources/secrets.ts: encryption, trial claim, deployment signing and preview signing secrets; installation-id is intentionally public.
- RandomId regular outputs: b64Std, b64Url, dec, hex. TLS provider already marks private key fields secret; audit pinned schema.
- Pulumi ignores additionalSecretOutputs for special resource id. RandomId id can encode key bytes; these annotations do not encrypt that special field. Migration/rotation is excluded and needs separate approval.
- Official references: https://www.pulumi.com/docs/iac/concepts/secrets/ and https://www.pulumi.com/registry/packages/random/api-docs/randomid/
- #2219 removed unsafe raw state summaries; never inspect/export plaintext state or use --show-secrets in verification.

## Checklist
- [x] Annotate all four regular encodings on all four generated secret resources.
- [x] Preserve exact names, inputs, protection, exports and public installation ID.
- [x] Test registration metadata and secret propagation using synthetic mocks only.
- [ ] Run lint/typecheck/tests/build and specialist reviews.
- [ ] Obtain safe redacted preview with no create/delete/replace of existing key resources.
- [ ] Open draft PR; satisfy exact-head CI and best-effort CodeRabbit.
- [ ] Report READY with head, PR, gates and safe preview evidence.
- [ ] Wait for explicit coordinator release before merge or deployment.
- [ ] Deploy and verify metadata safely after release.

## Acceptance
Regular generated key encodings are secret; resource identity and values preserved. Public installation ID stays public. Evidence prints only metadata/counts, never generated values. Any replacement or sensitive account change stops execution. Residual special-id limitation is disclosed.

## Workflow adaptation
SAM already provisioned the isolated output-branch workspace. Task tracked on that branch rather than pushing main while release slot is held. No production or staging mutation before explicit clearance.
