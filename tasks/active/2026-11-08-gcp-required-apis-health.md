# Keep required Google Cloud APIs enabled for connected GCP credentials

## Problem

The `gcp_price_table` scheduled sweep (added in #2572) fails every retry interval in production and
raises an operator Attention notification each time ("Operational sweep failed: gcp_price_table").
Prod evidence (2026-11-07): platform_errors `860b2d12…` (22:10Z) and `2a6424c0…` (23:10Z); the only
candidate is user credential `01M6NJE8E4M666WGGAWEAVPVYZ` (created 2026-11-05, before #2572 added
`cloudbilling.googleapis.com` to the setup API list). The refresh warn logs only
`errorName: ProviderError`; the HTTP status and Google reason are dropped, so the cause
(probably `SERVICE_DISABLED`) cannot be confirmed from logs. Idea `01M6W79RTFHXWMTNDMRBZ4ZG88`.

Root issue: SAM enables Google APIs only once, during WIF setup, with the user's short-lived OAuth
token. The runtime service account cannot (and should not) enable APIs. Whenever the required list
grows, every older credential drifts, and nothing tells the owner.

## Research Findings

- `apps/api/src/services/gcp-price-table.ts`: `refreshFromCandidates` catches each credential
  failure and logs `serializeError(error)` only (message redacted; `statusCode`/`providerCode`/
  `category` dropped). Returns `{status:'failed'}` and the scheduled step
  (`apps/api/src/scheduled/handler.ts` `gcp_price_table`) throws → `notifyFailedSweeps`.
- `packages/providers/src/provider-fetch.ts` `assertProviderResponseOk`: keeps `error.status`
  (`PERMISSION_DENIED`) as `providerCode` but drops Google `error.details[]` `google.rpc.ErrorInfo`
  (`reason: SERVICE_DISABLED`, `metadata.service`). Needed to tell "API off" from other 403s
  (for example `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, which is SAM's own bug and must keep alerting).
- `apps/api/src/services/gcp-setup.ts` `VM_APIS` + `enableApis()` + `runGcpSetup()`: every step is
  idempotent (409 → reuse/update, IAM read-modify-write skips existing bindings), so re-running
  setup is a safe repair. `/api/gcp/setup` already replaces the stored credential
  (`replaceUserGcpCredential`, new id).
- `GcpWorkloadIdentityCredential` (`packages/shared/src/types/user.ts`) records no API set.
  `parseGcpCredential` (`provider-credential-codecs.ts`) normalizes stored blobs.
- Settings UI `apps/web/src/components/GcpCredentialForm.tsx`: connected view has no re-run setup
  or re-check action; `SERVICE_ACCOUNT_COMMANDS` enables only `compute.googleapis.com`.
- `GET /api/credentials` (`routes/credentials.ts`) returns `gcp: toGcpCredentialMetadata(...)`.
- `POST /api/gcp/verify` exists (no UI caller in the form) and only verifies token/compute access.
- Project-scoped GCP credentials are created from identifiers (no setup run); platform GCP
  credentials have no setup flow. Surfacing is scoped to the user credential card; the sweep's
  classification and logging cover every credential source.

## Design

1. **Classify** (providers): capture Google `ErrorInfo` (`reason`, `service`) into
   `ProviderError.context.googleErrorInfo` in `providerFetch`. API helper classifies a Cloud
   Billing failure as an owner-fixable issue only for `SERVICE_DISABLED` (→ `api_disabled`) and
   `IAM_PERMISSION_DENIED`/`USER_PROJECT_DENIED` (→ `permission_denied`). Everything else stays a
   genuine fault (fail closed: no ErrorInfo → fault).
2. **Record** observed issues in KV per credential id (`gcp-api-health:v1:<id>`, TTL from admin
   setting); clear on a successful refresh/probe.
3. **Notify only on faults**: refresh returns `faults`; the sweep throws only when `faults > 0`.
   Log safe fields (`statusCode`, `providerCode`, `category`, `googleReason`, `googleService`).
4. **Track setup drift**: shared `GCP_REQUIRED_APIS` list (service + label). `runGcpSetup` stores
   `enabledApis` on the WIF credential; a WIF credential missing any required API (or with no
   record = predates tracking) reports `not_enabled_by_setup`.
5. **Surface**: `GcpCredentialMetadata.apiIssues`; Settings card shows a warning per API with an
   "Enable in Google Cloud" console link, "Re-run Google setup" (WIF; reuses OAuth flow with the
   current project/zone preselected), gcloud command (service-account key), and "Check again"
   (POST `/api/gcp/verify`, which now probes Cloud Billing and updates the record).

## Implementation Checklist

- [x] shared: `GCP_REQUIRED_APIS`, console URL constant, `enabledApis?` on WIF credential, `GcpApiIssue` + `apiIssues?` on metadata
- [x] providers: parse Google ErrorInfo into `ProviderError.context.googleErrorInfo`; `probeGcpBillingAccess()`
- [x] api: `gcp-setup.ts` uses shared list; `runGcpSetup` records `enabledApis`; parser preserves it
- [x] api: `gcp-api-health.ts` (classify, KV record/clear/read, required-API status)
- [x] api: price refresh records/clears health, logs safe fields, returns `faults`; sweep throws only on faults
- [x] api: admin setting for health TTL
- [x] api: `GET /api/credentials` + `/api/gcp/*` responses include `apiIssues`; `/api/gcp/verify` probes Cloud Billing
- [x] web: warning + Enable link + Re-run setup + Check again; preselect project/zone on re-run; SA gcloud command enables cloudbilling
- [x] tests: providers ErrorInfo parse; classification (SERVICE_DISABLED vs scope-insufficient vs no ErrorInfo); refresh records/clears + faults; sweep not notified for config-only, notified for faults; credentials route apiIssues; verify probe; parser preserves enabledApis; web component behavior
- [x] docs: google-cloud.md + self-hosting.mdx (re-run setup, Check again, notification behavior)
- [x] Playwright visual audit (375/1280) of the warning states

## Acceptance Criteria

- [ ] A price refresh where the only failures are `SERVICE_DISABLED` does not raise a failed-sweep notification; a scope/5xx/unknown failure still does
- [ ] Refresh failure logs include status code, provider code, category and Google reason/service (no message text)
- [ ] The Settings GCP card shows "Cloud Billing API is not enabled in project X" with a working console link when observed or when setup predates the API
- [ ] Re-run Google setup re-enables the full current API list and clears the warning
- [ ] Check again re-probes Cloud Billing and clears the warning once enabled
- [ ] New WIF setups record `enabledApis` and show no warning

## References

- Idea `01M6W79RTFHXWMTNDMRBZ4ZG88`; PR #2572
- `.claude/rules/72-error-categories-must-match-the-recovery-action.md`, `74-proxy-signals-must-match-the-condition.md`, `19-external-service-integration.md`

## Implementation Notes

- Banner on Settings → Infrastructure (`GcpApiIssuesBanner`) + notice in the Google Cloud card (`GcpApiIssuesNotice`). The accounts list is fed by `cc_*` APIs, so the banner reads `GET /api/credentials` (TanStack, cached) instead of mapping cc ids to legacy credential ids.
- `GcpCredentialForm` gets `onRefresh` from `CloudAccountForm` (which owns the credentials query) so "Check again" refreshes in place without advancing the connect sheet.
- Health record (KV `gcp-api-health:v1:<credentialId>`) holds `issues` (expire by `observedAt` + `gcpCatalog.apiIssueTtlMinutes`) and `confirmed` services; deleted on credential delete/replace. No KV TTL so a confirmed manual enablement does not silently re-flag.
- Legacy WIF credentials (no `enabledApis`) assume `GCP_APIS_ENABLED_BEFORE_TRACKING` (the pre-#2572 six). Credentials set up between #2572's deploy and this one have Cloud Billing on but no record; they show drift until a refresh/Check again confirms it.
- Discrimination proofs (surgical reverts, all restored):
  1. Remove ErrorInfo capture in `providerFetch` → 7 red incl. sweep-vertical "does not report Cloud Billing turned off".
  2. Notify on every failed refresh → exactly sweep-vertical "does not report ..." red.
  3. Widen owner-fixable to `ACCESS_TOKEN_SCOPE_INSUFFICIENT` → 3 red incl. sweep-vertical "reports a fault ...".
- Fixed a test-harness fidelity gap: `gcp-service-account-vertical` KV mock ignored the `'json'` read type.
- Known pre-existing UX: opening the connect sheet for an already-connected provider shows "This becomes your default…" copy above the card.
