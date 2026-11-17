# Bound Library multipart memory without changing stored encryption

## Problem and authorization
Shepherd task 01M7NBB7PJCTYXS7MY1T1DTGZ3 assigns scanner PR #2869 (48055f93b090f64c0a4abaaf2ad580eee7c7544d). Routine complete fixes may merge only after normal gates. Preserve scanner branch/history; do not ship its chunked AES-GCM format redesign. New security design requires a concrete independently reviewed Inbox decision.

## Research and preflight
Classes: security-sensitive, business-logic, public-surface, docs-sync. All 222 PR associations paginated; fresh full comments/reviews and exact URL/branch owners reconciled; no human hold or competing implementation found. Backend Implementation profile verified; session Codex weekly52%/OK. Contacted CSRF task01M7NB9FZNC4CXG6MGXJDQJM1C before route seams.

Trace: combined app authentication -> per-route approved user -> project:update capability -> Hono parseBody -> File.arrayBuffer -> shared uploadFile/replaceFile -> encryptFile -> R2 ciphertext + unchanged metadata and D1. Download uses existing decryptFile. Hono4.13.4 retains raw arrayBuffer and FormData in bodyCache; independent1MiB reproduction retains raw1048763 bytes plus parsedFile1048576. Actual upload/replacement limits occur after buffering. Native workerd formData still buffers and creates all parts; Hono bodyLimit trusts supplied Content-Length and buffers chunked requests. Existing shared bounded-request-body copies chunks into a contiguous body; unsuitable for large multipart. No streaming multipart parser dependency exists.

Candidate: standard incremental multipart parser, actual wire-byte bound regardless declared length, bounded parts/headers/metadata, one materializing write per isolate after authorization, scalar+ArrayBuffer extraction before unchanged shared operations. Preserve50MiB legitimate files and legacy format. New tunables use canonical admin registry; existing upload-max env remains compatible. No schema migration or new cryptographic design. Multiplication: only two Library browser write routes; existing MCP/service operations remain unchanged. Request I/O target<=12 roundtrips; new settings use shared cached snapshot, no per-part I/O. Document exact measured total/throughput after implementation.

Primary references: installed Hono utils/body.js and request.js; workerd http.c++ Body::formData and blob.c++ Blob::arrayBuffer; official remix-run/remix multipart-parser README/source (stable1.1.1 supports incremental parsing and finite part/header/aggregate budgets). Agent independently adversarially reviewed baseline and required flood/overlap tests. Local workerd baseline50MiB encrypt succeeds; this is not a production128MiB bound proof.

## Checklist and acceptance criteria
- [ ] Confirm shared route seam with CSRF owner; inspect current config and all callers.
- [ ] Reproduce actual stream amplification and retain discriminating regression.
- [ ] Implement smallest complete actual-byte, multipart-shape and admission bounds with unchanged encryption/storage/shared operations.
- [ ] Validate unknown/understated/overstated lengths, cap+1, malformed/truncated multipart, many parts, huge text/ignored fields and cancellation.
- [ ] Validate concurrent upload/upload and upload/replace; success/parser/crypto/storage failure releases admission without releasing live work early.
- [ ] Real trigger vertical slice:50MiB upload/download/replace/download and legacy encrypted file read; sequential maximum uploads and overlap controls.
- [ ] Measure outer-limit memory and throughput; document budgets and admin settings, no speculative runtime knobs.
- [ ] Full local lint/typecheck/tests/build and independent cloudflare/security/test/constitution/docs/completion reviews; adversarial re-verification.
- [ ] Replacement PR exact-head CI, trusted CodeRabbit request/wait; leased real staging after both queues and owners checked; cleanup and unchanged noise gate.
- [ ] Preserve useful scanner residual work in SAM Idea; close scanner only after verified replacement merge or proven invalid condition, concise closure with full links, no branch deletion.
- [ ] Merge only all gates satisfied, verify actual production deployment/basic health, publish per-PR results.
