# Typed Tool-Call Cards with DocumentCard + display_from_library MCP Tool

**Created**: 2026-07-03
**Source**: SAM idea `01KWKQC9G9NDK6X73D2KB6AX8B` ("Agent-rendered rich documents in chat")

## Problem Statement

Agents have no way to present rich documents (explanations, diagrams, images, reports) to users in project chat beyond plain markdown messages. The converged design: agents upload documents to the project file library (or reference existing ones), and the chat timeline renders those tool calls as rich **DocumentCards** with tiered inline previews and full-screen viewing via the existing `FilePreviewModal`.

Today all tool calls render through the generic `ToolCallCard`. There is no stable discriminator to dispatch on — the ACP `title` is a human-readable string that can change, and compact mode strips tool content, so card-critical data must survive in `toolMetadata`.

## Scope

1. **Go VM agent**: pass raw MCP tool name through `ToolMeta`/`toolMetadata` as a stable discriminator, plus bounded rawInput/rawOutput capture for card-critical fields.
2. **Card registry**: project chat timeline dispatches on tool name to typed cards, falling back to the generic `ToolCallCard`.
3. **DocumentCard** for `upload_to_library` / `replace_library_file` / new `display_from_library` tool calls.
4. **`display_from_library` MCP tool** (Worker-side only): validates fileId belongs to project, returns `{fileId, fileName, mimeType, size}`, optional `caption` rendered in the card.
5. **Full-screen**: DocumentCard opens the existing `FilePreviewModal`.
6. **Tiered inline previews**: image thumbnail (fetch-to-blob, credentialed, cross-origin), truncated markdown (clamp+fade, no mermaid inline), icon card for PDF/HTML/other. Graceful degradation on 404/oversize/unknown type.
7. **Compact-mode safety**: card-critical fields live in `toolMetadata`, not tool content.

## Research Findings

### R1: Tool name discriminator source (RESOLVED)

- The ACP protocol (`acp-go-sdk` v0.13.5 `SessionUpdateToolCall`) has **no toolName field** — only `Title`, `Kind`, `Meta map[string]any`, `RawInput`, `RawOutput`, `Content`, `Status`, `Locations`.
- The `claude-agent-acp` adapter (v0.23.1, verified in `dist/acp-agent.js`) sends `_meta: { claudeCode: { toolName: chunk.name } }` on **both** the initial `tool_call` (~line 1503) and the `tool_call_update` for mcp_tool_result (~line 1557). MCP tool names arrive as `mcp__<server>__<tool>` (e.g., `mcp__sam-mcp__upload_to_library`) or verbatim.
- Adapter also passes MCP tool names verbatim as ACP `title` in `toolInfoFromToolUse` default case → title-pattern fallback (`mcp__<server>__<tool>`) is viable for non-Claude adapters.
- → Checklist items C1, C2.

### R2: Go extraction path

- `packages/vm-agent/internal/acp/message_extract.go`: `ToolMeta` struct (lines 35-49) has `ToolCallId`, `Title`, `Kind`, `Status`, `Locations`, `Content`. Handles `u.ToolCall` (109-135) and `u.ToolCallUpdate` (138-173). `marshalRawContent()` truncates to `maxToolContentSize` (100KB, `MAX_TOOL_CONTENT_SIZE` env) with UTF-8-safe `truncateContent()`.
- Tests in `message_extract_test.go` (15 funcs; templates: `TestExtractMessages_ToolCall` line 166, `TestExtractMessages_ToolCallUpdate_WithStatus` line 243).
- → Checklist items C1–C3.

### R3: Frontend tool-call pipeline

- `ToolCallItem` type: `packages/acp-client/src/hooks/useAcpMessages.types.ts:27` — needs `toolName?: string` (and card payload passthrough).
- Persisted-message reconstruction: `apps/web/src/components/project-message-view/types.ts` `chatMessagesToConversationItems()` merges by `toolCallId`; status-only updates must not clear richer fields (existing pattern: `if (rawTitle) existing.title = rawTitle`). New fields must replicate this preserve-on-empty pattern (rule 02: persisted-representation parity regression test required, including a partial/status-only update event).
- Live-stream path: `useAcpMessagePayloads.ts` parses tool_call updates (`TOOL_STATUSES` set).
- Dispatch point: `apps/web/src/components/project-message-view/AcpConversationItemView.tsx` `case 'tool_call':` renders `AcpToolCallCard` (lines 116-124).
- Generic card: `packages/acp-client/src/components/ToolCallCard.tsx` (stays generic per idea; typed cards live in `apps/web`).
- Compact mode strips tool content from the RPC payload and lazy-loads via `contentPointer`/`onLoadToolContent` — card fields MUST come from `toolMetadata`.
- → Checklist items C4–C7.

### R4: MCP library tools (Worker-side)

- Definitions: `apps/api/src/routes/mcp/tool-definitions-library-tools.ts` (`LIBRARY_TOOLS` array, aggregated by `tool-definitions.ts` lines 17/32 — new tool auto-included in `tools/list`).
- Handlers: `apps/api/src/routes/mcp/library-tools.ts`. `handleListLibraryFiles` works without a workspace (precedent for `display_from_library`). Project-scoped validation via `getFile(db, projectId, fileId)`. Success format: `jsonRpcSuccess(requestId, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] })`. Structured `FILE_NOT_FOUND` payloads exist.
- Dispatch: `apps/api/src/routes/mcp/index.ts` `case 'tools/call'` — library cases ~349-356, handler imports lines 67-69.
- `upload_to_library` returns `{fileId, filename, sizeBytes}`; `replace_library_file` returns `{fileId, filename, sizeBytes, previousSizeBytes}` — the DocumentCard needs `mimeType` too; verify/extend result payloads so the card has what it needs from rawOutput.
- → Checklist items C8–C10.

### R5: Preview/rendering building blocks

- `apps/web/src/lib/file-utils.ts`: `isPreviewableImageMime` (png/jpeg/gif/webp/avif; SVG excluded — script risk), `isMarkdownMime`, `isPdfMime`, `formatFileSize`, `FILE_PREVIEW_INLINE_MAX_BYTES` (10MB), `FILE_PREVIEW_LOAD_MAX_BYTES` (50MB).
- Preview endpoint: `apps/api/src/routes/library.ts:298` `GET /:fileId/preview` — session auth (`requireAuth`, `requireOwnedProject`), MIME allowlist before decryption, `Cache-Control: private, no-store`. Cross-origin (app.→api.) so inline images need fetch-to-blob with `credentials: 'include'` (existing pattern in `FilePreviewModal` markdown fetch).
- `FilePreviewModal` props: `{file: FileWithTags, previewUrl, onClose, onDownload}` — DocumentCard must construct a `FileWithTags`-compatible object from card metadata (or fetch file details).
- Markdown clamp pattern: `apps/web/src/components/chat/TruncatedSummary.tsx` — `line-clamp-*` + ResizeObserver truncation check; DocumentCard markdown tier reuses the approach (no mermaid inline per idea).
- → Checklist items C5, C6.

### R6: Freshness & degradation edge cases (from idea)

- Library files are mutable (`replace_library_file`) → preview fetches at render time show current content; if `sizeBytes` differs from card metadata, show subtle "updated since" hint.
- 404 (file deleted) → tombstone state ("File no longer in library"), no broken modal.
- Oversize (> inline threshold) → icon card, modal still available (endpoint enforces its own cap).
- Unknown/unpreviewable MIME → icon card with name/size/caption. Every tier degrades downward, never to a broken state.
- IntersectionObserver lazy-load for image blobs + in-memory blob cache to avoid refetch on re-render.
- → Checklist items C5, C6.

### R7: Rules & constraints

- Rule 27: VM agent changes → staging verification requires deleting all nodes, deploying, then testing on a fresh node.
- Rule 17: Playwright visual audit mandatory (mobile 375x667 + desktop 1280x800, overflow assertion).
- Rule 02: regression tests for persisted stream parity (status-only update must not clear metadata).
- Rule 06 (api-patterns): errors via `AppError`/structured JSON-RPC error payloads; update `specs/001-mvp/contracts/api.md` if endpoints change (MCP tool addition → update MCP docs where library tools are listed).
- Rule 18: keep new files under 500 lines.
- Rule 26: project chat first — this feature is chat-native by design. ✓
- Constitution XI: size thresholds already env-configurable via existing `file-utils.ts` constants; reuse them.

## Implementation Checklist

### Go VM agent (packages/vm-agent)

- [x] C1: Add `ToolName string` to `ToolMeta`; populate from `Meta["claudeCode"]["toolName"]` on both `u.ToolCall` and `u.ToolCallUpdate`; fallback: parse `mcp__<server>__<tool>` from `Title`. Preserve-on-empty on updates (don't clear an already-known name).
- [x] C2: Add bounded `RawInput`/`RawOutput` capture to `ToolMeta` (JSON, size-capped like content truncation) so card-critical fields (fileId, filename, mimeType, sizeBytes, caption) survive compact mode inside `toolMetadata`.
- [x] C3: Go tests: tool name from `_meta` on initial call; tool name from `_meta` on update; title-pattern fallback; status-only update does not clear ToolName/raw fields; rawInput/rawOutput size cap.

### Frontend types & merge (packages/acp-client + apps/web)

- [x] C4: Add `toolName?`, `rawInput?`, `rawOutput?` to `ToolCallItem` (`useAcpMessages.types.ts`); parse in live-stream payload handling (`useAcpMessagePayloads.ts`) and persisted reconstruction (`project-message-view/types.ts`) with preserve-on-empty merge; parity regression tests incl. status-only update event.

### Card registry + DocumentCard (apps/web)

- [x] C5: Card registry module (e.g., `apps/web/src/components/project-message-view/tool-cards/registry.ts`): `matchToolCard(item) → FC | null`, dispatch on `toolName`; wire into `AcpConversationItemView` `case 'tool_call'` with fallback to `AcpToolCallCard`. Behavioral tests: registered name renders typed card, unknown name falls back.
- [x] C6: `DocumentCard` component for `upload_to_library`/`replace_library_file`/`display_from_library`: extract fileId/fileName/mimeType/sizeBytes/caption from rawInput/rawOutput metadata; tiered preview (image fetch-to-blob credentialed + IntersectionObserver lazy-load + blob cache; markdown clamp+fade via credentialed fetch, no mermaid; icon card otherwise); caption rendering; failure states (404 tombstone, oversize→icon, fetch error→icon); pending/in_progress states before result arrives; click → `FilePreviewModal`; behavioral tests for each tier + degradation.
- [x] C7: Playwright visual audit spec for DocumentCard scenarios (image/markdown/icon/tombstone/long caption/many cards) at 375x667 and 1280x800 with overflow assertions; screenshots in `.codex/tmp/playwright-screenshots/`.

### MCP tool (apps/api)

- [x] C8: Add `display_from_library` definition to `LIBRARY_TOOLS` (required `fileId`, optional `caption` string; description tells agents it renders a document card to the user).
- [x] C9: `handleDisplayFromLibrary` in `library-tools.ts` (no workspace required): validate via `getFile(db, projectId, fileId)`; return `{fileId, fileName, mimeType, sizeBytes, caption}`; structured `FILE_NOT_FOUND` on miss. Dispatch case in `mcp/index.ts`.
- [x] C10: Ensure `upload_to_library`/`replace_library_file` result payloads include `mimeType` (extend if missing) so DocumentCard can pick preview tier from rawOutput.
- [x] C11: Integration tests (Miniflare): display_from_library happy path, cross-project fileId rejected, missing fileId, caption passthrough.

### Docs & validation

- [x] C12: Update MCP/library tool docs (instructions text where library tools are described; check `apps/www` docs + `get_instructions` guidance) to mention `display_from_library` and the upload→card workflow.
- [x] C13: Full quality suite (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`), Go tests via CI (no local Go toolchain).
- [ ] C14: Data-flow trace (rule 10) in PR: adapter `_meta` → Go ToolMeta → outbox → DO `tool_metadata` → WS/RPC → ToolCallItem → registry → DocumentCard → FilePreviewModal.

## Acceptance Criteria

- [x] A1: `toolMetadata` persisted for MCP tool calls includes the raw tool name and bounded rawInput/rawOutput; visible in DO-persisted messages and after compact-mode stripping.
- [x] A2: `upload_to_library`, `replace_library_file`, and `display_from_library` tool calls render as DocumentCard in project chat; all other tools render the generic ToolCallCard unchanged.
- [x] A3: `display_from_library` validates project ownership; cross-project fileIds return FILE_NOT_FOUND; caption is returned and rendered.
- [x] A4: Image files show an inline thumbnail (credentialed blob fetch); markdown shows a clamped text preview; PDF/HTML/other show an icon card — each degrades gracefully on 404/oversize/error.
- [x] A5: Clicking the card opens `FilePreviewModal` with working full preview + download.
- [x] A6: Status-only tool_call_update events do not erase card metadata (regression test).
- [x] A7: No horizontal overflow at 375px; visual audit passes both viewports.
- [ ] A8: Staging E2E (fresh node per rule 27): agent uploads a markdown doc + displays an existing image via display_from_library; cards render with previews; modal opens.

## References

- SAM idea `01KWKQC9G9NDK6X73D2KB6AX8B`
- `packages/vm-agent/internal/acp/message_extract.go`
- `packages/acp-client/src/hooks/useAcpMessages.types.ts`
- `apps/web/src/components/project-message-view/{types.ts,AcpConversationItemView.tsx}`
- `apps/api/src/routes/mcp/{tool-definitions-library-tools.ts,library-tools.ts,index.ts}`
- `apps/web/src/lib/file-utils.ts`, `apps/web/src/components/library/FilePreviewModal.tsx`, `apps/web/src/components/chat/TruncatedSummary.tsx`
- Rules: 02, 06, 10, 17, 18, 26, 27, 35
- Prior art: `tasks/archive/2026-03-07-enrich-project-chat-tool-calls.md`, `tasks/archive/2026-05-22-summary-card-markdown-rendering.md`

## Completion Notes (2026-07-03)

Implemented on branch `typed-tool-call-cards-document-card`. Six specialist reviewers ran (task-completion-validator, cloudflare, security, go, ui-ux, test); all findings addressed or documented. No CRITICAL/HIGH.

**Accepted deviations from the original plan (validated as correct):**
- **C6 image tier** uses native `<img loading="lazy">` (with `onError` degradation) rather than IntersectionObserver + fetch-to-blob + blob cache. This matches the shipped `ImageViewer`/`FilePreviewModal` pattern (cross-origin credentialed `<img>` works because the browser sends cookies for image subresources and CORS allows `*.BASE_DOMAIN`). The chat list is already virtualized, so off-screen cards don't mount — lazy-loading is effectively free. Simpler and lower-risk than a new blob-cache layer.
- **C11**: `display_from_library` is covered by handler-level unit tests (happy path no-workspace, cross-project rejection with projectId-scope assertion, missing fileId, caption passthrough/truncation/floor), consistent with how `upload_to_library`/`replace_library_file` are tested. The route dispatch case is covered by the `tools/list` count assertion + import check.
- **C3 Go "status-only doesn't clear"**: architecturally N/A at the Go layer — `ExtractMessages` is stateless per-notification; the preserve-on-empty merge invariant (A6) is enforced and regression-tested on the frontend (both `chatMessagesToConversationItems` and `useAcpMessages`).
- **C12**: user-facing docs updated (`chat-features.md`). `instruction-tools.ts` was not touched — it currently lists no library tools at all (pre-existing), and the tool's own `description` field guides agent discovery.

**Security follow-up filed**: `tasks/backlog/2026-07-03-harden-markdown-preview-sanitization.md` for two pre-existing preview-sanitization surfaces (mermaid `foreignObject` mXSS, PDF-preview CSP) surfaced during review — not introduced by this change.

**Remaining (Phase 6/7):** C14 data-flow trace goes in the PR description; A8 staging E2E on a fresh node per rule 27.
