# Chat attachment staging and delivery

## Problem
New chats stage attachments in R2, while existing chats upload directly to a live workspace and append a transcript-only notification. Sleeping sessions fail and agents miss file references. Paste and drop are unsupported.

## Research
- `useAttachments.ts`: existing R2 queue, index-based async updates race removal.
- `useSessionFileUpload.ts`: immediate workspace upload, optimistic transcript only.
- `send-chat.ts`: durable message acceptance and metadata; VM delivery adapter resolves/wakes target before submission.
- `workspace-attachments.ts`: shared transfer defaults to /workspaces/.private; eager deletion prevents safe transfer retries.
- `ProjectChatComposer.tsx`: shared new/follow-up composer; reuse attachment chips.

## Plan
- [x] Shared stable-identity R2 upload queue for new and follow-up chats; removable attachments, visible failures.
- [x] Paste images/files and long text, drop files, consistent submit gating.
- [x] Validate owned attachment references at follow-up acceptance and persist them with durable message.
- [x] Transfer after runtime readiness and before prompt; retry safely; include explicit per-upload file paths.
- [x] Regression tests for queue removal, ingestion, ownership, failed transfer, wake ordering and prompt references.
- [x] Documentation, specialist reviews, mobile/desktop screenshot audits.
- [ ] Staging new/active/sleeping verification, clean up, green CI, CodeRabbit request/wait, merge and production deployment.

## Acceptance
Multiple files upload to R2 immediately and remain removable before send. No workspace transfer or agent prompt until send. Sleeping sessions wake before transfer. Agent receives exact readable file paths. Failed upload/transfer never silently drops attachments. Normal short-text paste remains text.

## UI variants
1. Existing attachment chips above composer, with paste/drop ingestion (selected: familiar and compact).
2. Separate upload drawer (extra navigation without benefit).
3. Full-chat drop overlay (larger target, but obscures transcript; composer target satisfies request).

## References
.do-state.md; scoped web/API rules; ui-ux-specialist; /do workflow.

## Local evidence
- Initial API focused suite 112 tests passed; web focused queue/composer/lifecycle/navigation suite 50 passed.
- API/web builds passed; full repository lint/typecheck passed before final review edits; recheck final edits.
- Four Playwright attachment audits passed (new/active × 375×667/1280×800). Screenshots reviewed; fixed new-chat starter area min-height to keep Send visible; bounded chip list height.
- Local backend/security/Cloudflare/constitution review PASS. UI review 4/4/4/4/5; addressed empty-file text, attachment-only send, retry/scope tests. Completion review identified duplicate plain WS + enriched durable messages; attachment sends now rely solely on durable transcript persistence.
- Staging, CI, CodeRabbit, merge and production remain pending. No completion claim before those gates.

## Staging deployment blocker
Initial deployment 38756062202 failed Cloudflare validation10021 (Worker startup CPU). The local startup profile identified eager speech model-registry initialization. Deferred the two speech-only imports inside their existing request-time error handling: active startup CPU fell from1462.8ms to530.2ms locally; all94 speech tests passed, backend reviewer PASS. This narrow adjacent fix is required to deploy the attachment changes. Full API suite12386passed with one boot callback timeout; isolated rerun9/9passed.
