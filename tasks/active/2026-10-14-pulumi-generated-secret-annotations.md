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

## Verified special-ID evidence (public source only)
The repository pins `@pulumi/random` 4.21.0. Its [provider/go.mod](https://github.com/pulumi/pulumi-random/blob/v4.21.0/provider/go.mod) pins the random provider fork at `f8d869dc98d9`. That revision's [resource_id.go](https://github.com/pulumi/terraform-provider-random/blob/f8d869dc98d9/internal/provider/resource_id.go#L139) constructs the physical ID with `base64.RawURLEncoding.EncodeToString(bytes)` and assigns it to ID; b64URL is prefix + ID. SAM sets no prefix, so the physical ID equals b64Url and decoding either reconstructs the same 32 bytes. This is source evidence, not inspection of any deployed resource.

The pinned [Pulumi schema](https://github.com/pulumi/pulumi-random/blob/v4.21.0/provider/cmd/pulumi-resource-random/schema.json) does not mark these regular encodings secret. [Pulumi's documented physical-ID limitation](https://www.pulumi.com/docs/iac/concepts/secrets/#the-resource-id-cannot-be-made-secret) says ID is always plaintext in the checkpoint and additionalSecretOutputs cannot change it. A synthetic local encoding check verified byte recovery and equality, printing booleans/length only; no provider engine or production state was involved.

### Claim boundary
The annotation fix achieves its **code scope**: all four regular encodings on all four existing key resources are marked secret, and source names/inputs/protection/exports are preserved. Engine persistence and no-replacement behavior still need the safe preview/deploy gates. It does **not** achieve removal of all reconstructable key material from plaintext checkpoint fields, does not repair historical checkpoints/backups, and is not evidence of past exposure. Stack exports already wrapped in pulumi.secret remain unchanged.

### Separate mitigation options — not implemented or authorized
1. **Existing containment:** treat checkpoint access as key access; preserve current private backend and backup controls. Annotation is defense in depth for regular properties and downstream secret tracking. No account settings or permissions are changed by this PR.
2. **Preserve values through a separate storage migration:** securely transfer existing bytes into encrypted Pulumi config or an approved secret store and keep runtime bytes unchanged, then retire old RandomId records and address historical checkpoints/backups. This needs an explicit migration approval covering secure value handling, resource retirement/identity changes, historical-state cleanup and rollback/preservation risks. Nothing in this task authorizes reading production bytes or editing state.
3. **Future generation with opaque IDs:** use a provider/storage mechanism whose physical ID is independent of the secret and whose secret outputs are encrypted. Prove that behavior with a synthetic engine fixture first. A provider substitution on existing resources is not safe to assume equivalent; replacement/rotation and any byte-format changes require separate approval and coordinated migration of encrypted data/signing consumers.
4. **Whole-checkpoint envelope encryption:** an approved backend/storage layer that encrypts the entire checkpoint can protect physical IDs in stored objects, unlike Pulumi property annotations. It needs separate security-design/account-setting approval and compatibility/recovery validation; storage-at-rest encryption alone does not hide key material from authorized raw-state readers.

Do **not** substitute RandomBytes as an ID fix: the pinned [Pulumi bridge computeRandomBytesID](https://github.com/pulumi/pulumi-random/blob/v4.21.0/provider/resources.go#L120) deliberately derives its physical ID from base64 key material. Adding id to additionalSecretOutputs or wrapping stack exports also cannot fix the special field. Rotation is not proposed absent confirmed exposure and explicit approval.

## Approved metadata-only preview mode
Root explicitly authorized a minimal mode in the existing credential-backed workflow on2026-10-14. `secret-metadata-preview` is a separate job in `pulumi-state-repair.yml`; repair steps cannot execute for this action. It retains contents:read, existing GitHub environment approvals/secrets, and environment-scoped serialization. Credentials stay on the Actions runner.

The script targets exactly the four existing RandomIds, passes refresh=false, suppresses stack outputs, never exports state/saves a plan, and discards raw child stdout/stderr on failure. Preview JSON is parsed only inside the trusted runner; IDs/inputs are compared in memory and only equality/protection/secret booleans, operation counts and fixed resource types are emitted. Four keys must exist; any non-same operation, replacement reason, unexpected target type, changed identity/input/protection or absent secret property fails closed. No key/resource mutation occurs. Temporary local config is deleted and no config-set/stack-init/select occurs.

Runtime limits are existing-environment variables `PULUMI_METADATA_PREVIEW_TIMEOUT_MS` (default600000) and `PULUMI_METADATA_PREVIEW_MAX_BYTES` (default16777216). No variable setup is required; empty values use defaults. The15-minute job limit bounds setup and execution. These limits affect local runner processing, not cloud resource provisioning.

- [ ] Security/code review new workflow and failure/redaction behavior.
- [ ] Run synthetic regression tests and relevant quality checks.
- [ ] Run exact-head trusted metadata preview using existing staging environment and approvals.
- [ ] Update CI and CodeRabbit evidence for expanded final diff.

### Live preview contract correction
First run38537591671 emitted only safe metadata:24same/fourkeys/unchangedinputs&protection, but verifier failed on new IDs/outputs. Public [preview digest source](https://github.com/pulumi/pulumi/blob/master/pkg/backend/display/json.go#L198) captures pre-step state and only substitutes completed outputs for refresh; [SameStep.Apply](https://github.com/pulumi/pulumi/blob/master/pkg/resource/deploy/step.go#L168) copies old ID/outputs later. Missing new identity/output fields do not imply rotation. Updated verifier accepts unknown pre-step IDs only when every operation is same/no-diff, old identity exists and target type/URN/provider/inputs/protection match. A supplied different new ID still fails. AdditionalSecretOutputs booleans prove declaration intent; persistedSecretMetadataVerified remainsfalse until authorized apply and post-deploy verification. Untargeted same resources, including installation-id, cannot count toward the four targets and are not misclassified as secret keys. Regression test covers this observed contract shape using synthetic IDs only.
