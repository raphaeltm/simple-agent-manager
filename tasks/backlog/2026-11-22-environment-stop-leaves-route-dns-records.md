# Stopping a deployment environment leaves its app-route DNS records pointing at the deleted node

## Problem

`POST /api/projects/:projectId/environments/:envId/stop` (`apps/api/src/routes/deployment-environment-stop.ts`)
tears down the stack, detaches volumes and deletes the managed node, but does not delete the
environment's app-route DNS records. Route DNS cleanup (`cleanupAppRouteDNSRecords`,
`apps/api/src/services/dns-app-routes.ts`) runs only on environment delete
(`deployment-environments.ts`), node delete (`routes/nodes/delete.ts`) and the release callback's
stale-route sweep.

On hosted SAM the route record is an unproxied `A` record pointing at the node's public IP. After a
stop, the record points at a cloud IP SAM has released, and the provider can reassign that IP to
another customer. That is a dangling-DNS / subdomain-takeover risk for `*.apps.<BASE_DOMAIN>`
hostnames, including on cookies scoped to the app hostname.

## Context

Found 2026-11-22 during hosted staging verification of PR #2974 (primary staging). Environment
`01KVJDV913S8W7KK32HTZTK0H8` ("Test Project 1") was stopped at about 14:58Z. The response was
`nodeDeleted: true`, and node `01M81V20VP4B69FHWAFWFZFDSS` is `deleted` with `ip_address` null. At
15:05Z the Cloudflare zone still held `A r1-app-80-01kvjdv913s8w7kk32htztk0h8.apps.sammy.party →
49.12.32.195` (unproxied). PR #2974 does not change the stop path; this predates it on `main`.

## Acceptance Criteria

- [ ] Stop deletes (or repoints) every route record of the environment once its node is released,
      and Start recreates them through the existing release-fetch upsert
- [ ] A test through the real stop route asserts the records are gone after a stop that deletes the node
- [ ] Consider a sweep for existing dangling route records whose target is no longer a live node
