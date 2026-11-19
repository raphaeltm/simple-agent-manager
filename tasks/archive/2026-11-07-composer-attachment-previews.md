# Composer attachment previews (cards + local-file viewer)

## Problem

The attachment indicator above the chat composer is a bare name chip (`CleanShot_2026-11-…  385 KB ✕`).
You can't confirm an image is the right one, see what a long paste (`pasted-<ts>.txt`) contains, or
tell file types apart. Raphaël reviewed three prototypes (2026-11-07, Library
`/design/attachment-previews-2026-11-07/`) and chose variant C, "Cards". He also wants previews to read
the **local** file, so a file that is too large to upload can still be identified.

## Research findings

- The composer chip row lives in `ProjectChatComposer` (`apps/web/src/components/project-chat/ProjectChatComposer.tsx`).
  It is used by the new-chat `ChatInput`, the follow-up `FollowUpInput` and `ArchivedForkComposer`, so one
  change covers every chat composer.
- Every attachment already carries the browser `File` (`AttachmentUploadState.file` in
  `apps/web/src/pages/project-chat/useAttachments.ts`), so previews can use `URL.createObjectURL(file)`
  with no fetch from R2.
- `useAttachments.handleChatFilesSelected` rejects empty and over-limit files **before** adding them
  (`setSubmitError` + `continue`), so they never show up and can't be previewed. Change: add them as
  `status: 'error'` items with a reason, and don't upload them. The existing send gate
  (`attachments.some(a => a.status !== 'complete')`) already blocks sending until they're removed.
- Long pastes become `pasted-<epoch>.txt` in the composer `onPaste` handler, so the composer can label
  them "Pasted text" and show the first line.
- Library preview patterns to align with: `isVideoMime` / `isPreviewableImageMime` (`lib/file-utils.ts`),
  `resolveEffectiveMimeType` (`packages/shared/src/mime.ts`), and the library `VideoPreview` (`<video controls playsInline preload="metadata">` with an `onError` fallback).
- Prototype stress testing found a real bug: a 300 KB single-line paste previewed as empty when the
  partial last line was dropped. Production must keep the only line.
- Build-time preview caps must be configurable (constitution XI): `VITE_*` env plus `DEFAULT_*`, documented
  in `reference/configuration.md` next to `VITE_PASTED_TEXT_ATTACHMENT_THRESHOLD`.
- Docs to update: `apps/www/src/content/docs/docs/guides/chat-features.md` ("Attach Files to a Message").

## Implementation checklist

- [x] `components/project-chat/attachments/attachment-kind.ts`: classify a File (image / video / text / other), icon, badge, paste label, configurable caps
- [x] `useLocalFilePreview.ts`: `useObjectUrl` (revoked on change/unmount) and `useAttachmentInfo` (head sniff, line count)
- [x] `ComposerAttachmentList.tsx`: image tiles + file cards, separate remove button, upload ring / error wash, count + size summary when there are more than 3
- [x] `AttachmentPreviewDialog.tsx` (+ text body file): image fit/100%, video player, text viewer (wrap, caps, single-line fix, Edit in message for pastes), icon card for others, failed banner, prev/next + arrow keys, remove (stays open on the next file), Esc restores focus
- [x] Wire into `ProjectChatComposer`; add optional `id` to `ProjectChatComposerAttachment` for stable keys
- [x] `useAttachments`: empty / over-limit files become previewable failed attachments (not uploaded)
- [x] Unit tests: card rendering per kind, tap opens preview from the local object URL with no fetch, remove doesn't open preview, Edit in message, video element, oversize file previewable, single-line truncation
- [x] Playwright audit spec over the real composer (mobile + desktop, stress data, `assertNoOverflow`)
- [x] Remove prototype (`pages/attachment-preview-prototype/`, `App.tsx` route + import)
- [x] Docs: chat-features attach section; configuration.md VITE vars

## Acceptance criteria

- [x] Images show a thumbnail; tapping opens a viewer of the local file (fit / 100%, dimensions)
- [x] Videos play locally in the viewer; undecodable media falls back to an icon card
- [x] Pastes show "Pasted text"-style cards with first line + line count; the viewer shows numbered lines, capped, and can move the text back into the message
- [x] Other files show a typed icon + extension + size
- [x] An over-limit or empty file appears as Failed, can be previewed, and blocks send until removed
- [x] Removing never opens the preview; keyboard access works and focus returns to the trigger
- [x] No overflow at 375px / 1280px with 20 files, long names, upload states

## Notes

- Staging skipped with explicit approval from Raphaël (2026-11-07 chat: UI-only, go straight to prod).
