# Fix Admin Logs Query Error

## Problem

The Admin > Logs tab on staging (`app.sammy.party/admin/logs`) returns an error:

```
Cloudflare Observability API returned 400: {"success":false,"errors":[{"message":"Bad Request","detail":"Query not found"}],"messages":[]}
```

The log viewer fails to load any logs, showing "No logs found for the selected filters."

## Context

- Discovered during staging investigation on 2026-03-02
- The Admin dashboard's Logs tab proxies requests to the Cloudflare Observability API
- The API returns HTTP 400 with "Query not found" — likely a missing or misconfigured query ID, or a Cloudflare API change

## Acceptance Criteria

- [ ] Admin > Logs tab loads and displays Worker logs correctly on staging
- [ ] Identify whether the issue is a missing query configuration, API key permission, or Cloudflare API change
- [ ] Fix the query/configuration issue
- [ ] Verify the fix on staging after deployment
