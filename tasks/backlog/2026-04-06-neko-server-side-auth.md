# Neko Server-Side Authentication (Remove Password from URL)

## Problem
The `autoLoginUrl` returned by `handleStartBrowser` exposes the Neko viewer password as a plaintext query parameter (`?usr=user&pwd=<hex>`). This URL appears in browser history, Referer headers, and network logs.

## Context
Discovered during security audit of PR #611. Pre-existing pattern from the original Neko sidecar implementation (PR #568). The password is defense-in-depth (SAM handles auth at the proxy layer), but exposing it in URLs is unnecessary.

## Proposed Solution
Route Neko authentication through the existing proxy layer — inject credentials server-side via the reverse proxy rather than passing them through the URL.

## Acceptance Criteria
- [ ] Neko password not exposed in any API response or URL
- [ ] Proxy injects authentication headers/cookies when forwarding to Neko
- [ ] Auto-login still works seamlessly for the end user
