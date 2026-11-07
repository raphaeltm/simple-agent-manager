# Live GCP catalog: machine types per zone, priced from Google's list prices

PR 2b of the provider-priority work (idea `01M6NXTF2RQ5QXHM7YZ4ZF0XBK`). Raphaël (2026-11-06):
"dynamic google pricing and regions, etc. should be part of this. I don't think hardcoding is
acceptable." Stacked on PR 2a (`sam/gcp-dynamic-zones`, zones validated by shape).

## Problem

The GCP node-pool catalog was never live. `createCatalogProvider` built `GcpProvider` with a token
provider that threw on every call, and `GcpProvider.listInstanceOfferings` returned the static
table regardless: 3 machine types (`SIZE_MAP`) × 8 zones, at three hardcoded `~$N/mo` prices.

## Research findings

- Compute `machineTypes.aggregatedList` lists machine types per zone; the filter accepts an RE2
  full-match `name eq "(a|b)"`. Unreachable zones come back as scope warnings.
- Machine types are not priced as a unit. The Cloud Billing Catalog (`v1/services/6F81-5844-456A/skus`,
  public SKUs, OAuth `cloud-platform` / `cloud-billing(.readonly)`) has per-region "<SERIES>
  Instance Core|Ram running in <place>" SKUs; price = vCPUs × core + GiB × RAM. Shared-core E2
  types bill a fraction of their vCPUs (e2-medium bills 1 of 2). These reproduce Google's
  published prices (e2-standard-2 $48.91/mo, e2-medium $24.46/mo in us-central1).
- The SKU list is many pages of up to 5000 SKUs. Downloading it on the catalog request path would
  exceed the 10 s catalog deadline, and list prices are identical for every project. So: one table
  per installation in KV, refreshed by a scheduled step, read by catalog builds.
- WIF impersonation requested only the `compute` scope; the Billing Catalog needs
  `cloud-billing.readonly` (or `cloud-platform`). The Cloud Billing API must be enabled in the
  project whose token reads it; the setup flow enables APIs via `VM_APIS`.
- Workload identity binds a project-scoped credential to its SAM project
  (`assertion.project_id`), so catalog tokens must be minted with the same identity as
  provisioning (`createProviderFromDecryptedToken`). Catalog seeds did not carry the project.
- Default pools activate only offerings matching a legacy size (`machineSize`), so live rows for
  e2-medium/e2-standard-2/e2-standard-4 keep the legacy-size mapping.
- An incomplete catalog falls back to static rows, which cannot overwrite live candidates
  (`default-capacity-pool-candidates-statements.ts`), so a partial listing must throw.
- Deferred to PR 4 (UI, needs a Playwright audit): the credential form's zone picker
  (`GcpCredentialForm.tsx` `GCP_ZONES`) and its manual-mode `gcloud services enable` command,
  which should add `cloudbilling.googleapis.com`. The self-hosting docs already list it. Without
  it, manual-mode connections show "Price unavailable" until another credential refreshes prices.

## Implementation checklist

- [x] `gcp-pricing.ts`: SKU parser (anchored, on-demand only, unit checked, USD, last tier),
      conflict → unknown, paginated fetch with page cap and repeated-token guard, stored-table
      validator
- [x] `gcp-catalog.ts`: machine types aggregated list with exact-name filter, unreachable → throw,
      deprecated skipped, offerings with price/unpriced, legacy size mapping
- [x] `GcpProvider` takes `GcpCatalogOptions`; API-backed only when given; a failing price source
      leaves offerings unpriced
- [x] `listVMs` moved into `gcp-instance-lookup.ts` (rule 18)
- [x] `createGcpTokenProvider` shared by provisioning and the catalog; seeds carry `ownerProjectId`
- [x] `gcp-price-table.ts` + isolated cron step `gcp_price_table` (TTL, failure backoff,
      platform-first credentials, attempt cap)
- [x] Admin settings `gcpCatalog.*`
- [x] Price read requests `cloud-billing.readonly` alone (provisioning tokens stay compute-only);
      setup enables `cloudbilling.googleapis.com`
- [x] Docs: google-cloud.md, self-hosting.mdx, admin-settings.md, compute-pools.md,
      configuration.md, `.env.example`
- [x] Tests: SKU parsing and exclusions, conflicts, pagination, disabled API, machine-type filter
      injection, offerings priced to Google's published numbers, shared-core billing, unpriced,
      deprecated, unreachable, static fallback; price table refresh (platform first, token
      identity per source, next credential on failure, TTL, backoff, no credential, malformed);
      catalog build end to end (live + complete, project token identity, unpriced, unreachable)
- [x] Surgical revert: without catalog options all 4 catalog-build tests go red

## Acceptance criteria

- [x] A GCP pool's catalog lists the configured machine types in every zone Google reports
- [x] Offerings carry live list prices, or "Price unavailable" — never a guessed price
- [x] The price download never runs on a request path
- [x] Catalog tokens use the same workload-identity binding as provisioning
- [x] A partial (unreachable-zone) listing keeps last-known live offerings

## Staging

Waived by Raphaël for this work (session `eecddba8`, 2026-11-07). GCP is not connected on staging.

## Review fixes

- security-auditor MEDIUM: billing scope no longer added to every token; `getGcpAccessToken`
  takes a `scopes` option used only by the price read (separate cache key).
- cloudflare-specialist MEDIUM ×2: overall refresh budget (`gcpCatalog.priceRefreshBudgetMs`,
  default 90 s), step moved after the lifecycle sweeps, no-credential backoff. LOW ×2: one
  price-table read per catalog build, no D1 over-fetch.
- test-engineer MEDIUM: real WIF exchange test for scopes and cache separation; budget test.
  LOW deferred: a single test from live catalog to pool candidate activation (both halves
  are covered separately: the live offering carries `machineSize`, and pool activation by
  `machineSize` is tested generically).
- doc-sync LOW ×2: incomplete-read wording; providers AGENTS.md GCP entry.
