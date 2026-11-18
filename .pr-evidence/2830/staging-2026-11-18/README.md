# PR2830 primary staging evidence

Deployed exact20a155c2f9a3bae078ddc90283efbb67077d5f3a, workflow44220668713 SUCCESS including smoke tests.

Screenshots: hybrid: linked-accounts response intercepted; no email-only staging principal exists; coordinator-approved. Only the browser GET /api/auth/list-accounts response omits GitHub; all other responses, UI bundles, session, step-up request/mail send, and D1 are real primary staging. Existing shared fixtures' provider links were not modified. Screenshots reviewed at375x667 and1280x800: no overflow/clipping/readability problems. Source remains on the feature branch; NEVER MERGE this evidence branch.

Hybrid report records successful live token sign-in, verified session, unlinked GitLab without/with forged proof refused403, Google refused400, health200, responsive UI, real Connect GitHub click and confirmation request200, unchanged provider links, stored session IP equals Cloudflare trace IP, zero API5xx/page/console errors, sign-out200. Real OAuth/provider consent/mail delivery/unlink remain unverified under the human exception recorded in the PR.

Separate primary regression run observed /api/auth/list-accounts500 and browser console error at02:30:50–02:31:11UTC. This is a merge blocker under investigation. It is not covered by the successful hybrid report. D1 platform_errors query after02:30:45 returned no rows. Bounded Worker-tail reproduction requested.

24h observability noise: six groups predate the02:05UTC deployment request in their entirety: session verification72, providerless handoff67, providerless max lifetime57, second handoff47, snapshot33, GCP price12. Zero occurrences after request through02:29UTC. Telemetry query unavailable403. The overall noise command is FAIL, not claimed PASS.
