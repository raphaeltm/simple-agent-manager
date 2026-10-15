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
- [ ] Shared stable-identity R2 upload queue for new and follow-up chats; removable attachments, visible failures.
- [ ] Paste images/files and long text, drop files, consistent submit gating.
- [ ] Validate owned attachment references at follow-up acceptance and persist them with durable message.
- [ ] Transfer after runtime readiness and before prompt; retry safely; include explicit per-upload file paths.
- [ ] Regression tests for queue removal, ingestion, ownership, failed transfer, wake ordering and prompt references.
- [ ] Documentation, specialist reviews, mobile/desktop screenshot audits.
- [ ] Staging new/active/sleeping verification, clean up, green CI, CodeRabbit request/wait, merge and production deployment.

## Acceptance
Multiple files upload to R2 immediately and remain removable before send. No workspace transfer or agent prompt until send. Sleeping sessions wake before transfer. Agent receives exact readable file paths. Failed upload/transfer never silently drops attachments. Normal short-text paste remains text.

## UI variants
1. Existing attachment chips above composer, with paste/drop ingestion (selected: familiar and compact).
2. Separate upload drawer (extra navigation without benefit).
3. Full-chat drop overlay (larger target, but obscures transcript; composer target satisfies request).

## References
.do-state.md; scoped web/API rules; ui-ux-specialist; /do workflow.
