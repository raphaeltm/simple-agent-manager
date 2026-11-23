# Complete CLI terminal-output security PR #2864

## Problem and authority

API-derived and local diagnostic text can execute terminal controls. Scanner patch b967c83
contains useful shared encoding but only static assertions. Shepherd task
01M7NBAYYHJBRNB7FF4ZH9K0XB authorizes routine corrected completion after all gates.
All221 PR association records, full comments/reviews/files and exact active URL+branch owners
were reconciled before mutation: no competing owner or actual human draft/no-merge hold.
Continue original scanner history without force push or deletion; do not merge runtime state.
This continuation tracks work here rather than creating a redundant planning-only main commit.

## Research and preflight

Classification: public-surface-change, security-sensitive-change, docs-sync-change.
Output trace: command Run -> API client -> text/table/picker/device output or structured JSON;
fail -> redaction -> text/structured stderr. Rich workflow output reuses writeOutput.
Transcript stdout is encoded JSON/NDJSON; downloads and transcript files are artifacts.
Forwarding uses decoded HTTP request paths in diagnostics, while ReverseProxy streams remote
response bytes. CLI has no implemented PTY transport; runner doctor captures host output.
Independent actual invocations reproduced scanner omissions in contextual help (ESC/BEL)
and JSON output (C1/DEL). Local HTTP forward invocation verified decoded hostile paths were
safe after correction while remote response control bytes remained exact. No new trust,
authentication, cryptography or infrastructure design. No new dependencies or env knobs.
Constitution X/XI: shared encoder, fixed Unicode/protocol ranges; no tunable policy values.
I/O delta: zero API/D1/DO calls. Encoding O(n), at most6 ASCII bytes per input control rune,
no deferred work or new batch limits; existing API response/export byte budgets remain.

## Checklist and acceptance

- [x] Reconcile ownership, holds, fresh head and review evidence; verify session credential usage.
- [x] Trace every stdout/stderr sink and preserve HTTP/file/PTY contracts.
- [x] Retain scanner attribution/history and shared text sanitizer.
- [x] Correct contextual help, forwarding diagnostics, JSON stdout/error/device/export sinks.
- [x] Command-trigger scenarios cover every C0/C1 class, OSC/CSI/title/clipboard/BEL/DEL.
- [x] Unicode, repeated spacing, multiline chat and decoded JSON values remain exact.
- [x] Real local listener test proves escaped malicious request path and exact streamed body.
- [x] Disable sanitizer once: new boundary scenarios fail, then restore and verify green.
- [x] Update public CLI guide in same implementation commit.
- [ ] Race/coverage, vet/build, docs and relevant repository checks pass; inspect Sonar exact head.
- [ ] Independent local Go/security/test/doc/constitution/completion reviewers all finish.
- [ ] Ready candidate requests trusted CodeRabbit once; resolve any received findings.
- [ ] Exact-head CI and safe leased staging CLI/API exercise plus cleanup pass.
- [ ] Merge with all gates; verify actual production deployment/basic health, report channel.

## Verification

Command-boundary tests use injected HTTP/env/writers and realistic API responses; real local
HTTP listener regression asserts request path and response bytes as well as inert diagnostics.
Existing API error-message suppression remains in effect (hostile server message is not echoed).
Staging/CI/review evidence will be linked from the PR description. No production user flows.

## Review correction

Codex review4604056329 identified sanitization expansion moving table's byte cutoff into
multibyte Unicode. Reproduced from Run(projects): DEL+é/CJK/emoji at cutoff produces U+FFFD
because the final renderer replaces the split rune. SanitizeTableCell now backs the cutoff
up to a UTF-8 rune boundary while retaining its existing byte width. Regression failed on
all3 examples before the guard and passes after it. No transport/JSON behavior changed.
CodeRabbit review5944517877 requested full release-template sections; populated honestly
with staging and exact-head CI pending. Its approval5944519326 does not waive those gates.

## Reconciliation (2026-11-23, weekly queue reconciliation)

- Shipped in [#2864](https://github.com/raphaeltm/simple-agent-manager/pull/2864) (merged 2026-11-18).
- Production deploys from `main` have succeeded continuously since then (latest `7d40cfb2d`, 2026-11-23).
- 5 line(s) stay unticked. They are verification or reporting steps that were not re-checked here; this record does not claim them.
