# Exact helper VM inventory diagnostic (isolated maintenance branch)

Root must review before adding/running this operation. Do not merge these files into the application branch. The script never writes D1/provider state and does not generate absence proof, including when the complete bounded inventory is empty.

The target is helper node `01M20KQDHX8M3YP89Q6QTQP6S1`, original incarnation `43ad0f49-94e5-44b2-9191-1fc40cab281f`, exact platform credential `01KNY6DC06C9QCYQM0389NAGNT`, staging Worker `sam-api-staging` at `db06843dd72812ed4f6b7e12a882363901ba1a9d`. It checks both the credential ciphertext fingerprint captured by the provider claim and the exact node/workspace ownership. Running/creating status does not imply absence and is not used to infer it. Worker and node identity are rechecked after inventory.

The script uses Node's built-in WebCrypto AES-GCM with the existing base64 ciphertext/IV format. Key precedence is CREDENTIAL_ENCRYPTION_KEY, ENCRYPTION_KEY, supplied PULUMI_ENCRYPTION_KEY, then existing Pulumi output `encryptionKey`. No dependency install is needed. The Pulumi fallback uses the canonical `resolveResourceNames` implementation, requires the same `sam-api-staging` resource name, and performs only `pulumi login` to the existing R2 backend and `pulumi stack output encryptionKey --show-secrets --stack staging`. It never runs stack init/select, preview, up, config, or export. Both subprocess output streams are captured in memory; no value is emitted to GitHub outputs/environment/artifacts or passed in command arguments.

The deploy workflow pins the Pulumi installer action below; it does not specify a separate CLI version. Reuse this canonical pinned action rather than inventing a version. Keep the protected `staging` environment and existing `deploy-staging` concurrency group.

Add `inventory-helper-vm` to the operation choices. These are the additional steps; do not alter the other maintenance operations:

```yaml
- name: Verify offline inventory guards
  run: node --test scripts/maintenance/pr2030-placeholder-cleanup/test-inventory.mjs
- name: Install Pulumi CLI for read-only inventory
  if: ${{ inputs.operation == 'inventory-helper-vm' }}
  uses: pulumi/actions@8e5e406f4007fca908480587cb9893c07090f58d # v7.0.0, same as deploy-reusable.yml
- name: Read exact helper provider inventory
  if: ${{ inputs.operation == 'inventory-helper-vm' }}
  env:
    CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
    CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
    BASE_DOMAIN: ${{ vars.BASE_DOMAIN }}
    RESOURCE_PREFIX: ${{ vars.RESOURCE_PREFIX }}
    PULUMI_STATE_BUCKET: ${{ vars.PULUMI_STATE_BUCKET }}
    CREDENTIAL_ENCRYPTION_KEY: ${{ secrets.CREDENTIAL_ENCRYPTION_KEY }}
    ENCRYPTION_KEY: ${{ secrets.ENCRYPTION_KEY }}
    AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
    PULUMI_CONFIG_PASSPHRASE: ${{ secrets.PULUMI_CONFIG_PASSPHRASE }}
  run: node scripts/maintenance/pr2030-placeholder-cleanup/inventory.mjs
```

Ubuntu's runner Node is sufficient (Node 22+ recommended); no pnpm install or application build is required. `apply` is ignored for this operation: there is no mutation branch. D1 is accessed only with exact SELECTs; provider access is GET-only, at most ten pages of 50 servers with 20-second request bounds. Redirects are refused. All servers are inspected internally to match either the exact node label or exact SAM node name; unrelated records and user data never leave memory. Output contains only the target node/incarnation and matching server ID/status/IP/creation/allowlisted ownership labels; mismatched label values are represented as `[mismatch]`, never printed verbatim.

After root reviews any matches, separately confirm ownership before using a supported repair/deletion mechanism. This script does not persist a provider ID, update DNS, prove termination, or delete anything. A Worker deploy or incarnation/credential change causes refusal and requires explicit review of the new incident state.
