# Verification-only Node 22 / async Playwright boundary

No live operation, login, fixture, cleanup, credential/cache change or deployment
is authorized. Coordinator containment clearance and exact-head review are required.
This matches A's sanitized Node ES-module APIRequestContext architecture. Do not
read or reuse the incident controller file/raw output. Replace its unsafe generic
response/error persistence when integrating; do not merely wrap a console print.

Run the trusted controller entrypoint under this supervisor:

```sh
node scripts/e2e/reliability-a/safe-controller.mjs /private/reviewed-controller.mjs 60000
```

The entrypoint exports `async run({requestSafe,logoutSafe,screenshotSafe,report})`.
It owns ONE existing browser/context and the entire launch/login/queue/close/finally
lifecycle inside `run`. Existing managed login stays internal; this artifact does
not add a login flow or extract any credentials. Return the final fixed summary
only AFTER awaited cleanup; `report` discards arbitrary progress data. The parent
accepts only a validated fixed summary over IPC. All child stdout/stderr, including
pre-existing loggers, native writes and inherited subprocess output, go to the null
device; neither diagnostics nor Playwright protocol text are captured or persisted.
Do not send credentials via IPC or write raw responses/errors/headers/cookies to
queue result files. Do not enable tracing, HAR, video or browser debug sinks.

For `{op:'request',path,method?,data?}`, use
`requestSafe(context, trustedApiOrigin, command, accept)`; pass the same context
for every command. `accept(json)` is an optional private schema-check callback and
must return a literal boolean. It must never print/persist a generic payload.
`privateState` extracts only typed allowlisted IDs/state/timestamps/counts; unknown
fields are dropped and malformed selected fields reject the result. Required fields
must still be asserted by the operation's specific callback. Private baseline or
expectation downloads require their existing exact-schema validators before any
private artifact write; there is no arbitrary text/body download fallback here.
No queue/result file may contain a body, URL, exception, stack, header or cookie.
Only persist `safeSummary(result)` to the ordinary result queue. Keep private typed
state/artifacts in a separately reviewed sink outside fixture state and public logs.
Integration of those specific sinks/controller entrypoint requires its own review.

`logoutSafe(context, trustedApiOrigin)` performs POST `/api/auth/sign-out` with the
normal exact Origin header, unchanged context cookies, and redirects disabled.
It rotates no global credentials. Origins must be explicit trusted HTTPS origins,
not response data. Requests only accept `/api/` paths without query/fragment.
`screenshotSafe` uses a trusted app origin and private artifact destination, returns
no URL/image path/exception and suppresses navigation/screenshot errors. Screenshots
must be of approved non-secret surfaces; this adapter does not redact image pixels.

Playwright receives a finite request timeout. The supervisor separately enforces a
finite deadline for the ENTIRE job, covering launch, parsing, queue hangs, blocked
callbacks/disposal and cleanup even if cancellation is ignored. At expiry it kills
the dedicated controller process group and emits only a fixed timeout summary.
Do not run unrelated work in that group; run a logout/cleanup operation in a separate
coordinator-authorized bounded job if the first controller has already terminated.
This is not a promise to kill arbitrary descendants that intentionally escape their
group; such descendants still inherit null streams. Do not detach controller work.
Stop on any non-ok result; no success is inferred from a failed/timeout job.

Synthetic tests, no Playwright installation/network/secrets:

```sh
node --test scripts/e2e/reliability-a/test-safe-controller.mjs
```

They execute the ACTUAL supervisor with synthetic credential-shaped canaries on
console/native/subprocess streams and startup/outer/finally errors, request network/
timeout/response/malformed/consumer/disposal failures, same-context logout Origin,
malformed paths/results, and hung launch/fetch/disposal bounded by the parent.
No live containment/logout/completion/sleep/wake result is claimed.
