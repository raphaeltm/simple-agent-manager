# Agent-agnostic tool-call card recognition (fix Codex display_from_library / DocumentCard)

SAM idea: `01KWVCX19XE0YKE5T6AQMXJTSD`

## Problem
In project chat, the library DocumentCard (`display_from_library`, `upload_to_library`, `replace_library_file`) does NOT render for **Codex (openai-codex)** sessions — it falls back to the generic tool card. Claude Code sessions render fine.

Verified in production 2026-07-06: session `e389e854-8ebe-4466-8f23-4324b0117685` (profile "Codex High Chat"). The prior fix (PRs #1488/#1508/#1517) DID deploy to production (main `26ed74a20`, 2026-07-05 23:21 UTC) and the active node `01KWV0778B03E7R2TBMF4P3WGT` (created 2026-07-06 06:00 UTC) runs the latest vm-agent. This is a code bug, not a deploy problem.

## Root cause
Tool-name recognition is coupled to a delimiter convention. Claude emits `mcp__<server>__<tool>` (double underscore) + `_meta.claudeCode.toolName`. Codex registers the MCP server as `sam-mcp` (`gateway.go:codexMcpServerName`) and titles tool calls `<server>/<tool>` → `sam-mcp/display_from_library` (**slash**). Every name-resolver only understands `mcp__`:
- vm-agent `extractToolName` / `toolNameNeedsRawCapture` (`packages/vm-agent/internal/acp/message_extract.go`)
- web `normalizeToolName` (`document-card-data.ts`) + `inferMcpToolNameFromTitle` (`types.ts`)

Consequence for Codex: vm-agent stores `toolName=""` (omitted) and skips the dedicated `rawInput/rawOutput` (capture gated on the name); web `matchToolCard` can't normalize the slash title → returns null → generic card.

Note: nothing human-facing is dropped — the display **title** and the output **content** are both stored and shown. The failure is pure *recognition*: the matcher checks the empty machine `toolName` with an `mcp__`-only parser.

## Architecture context (single path)
Project chat is 100% through Cloudflare now: browser ↔ Worker/ProjectData DO via `useChatWebSocket`, receiving `ChatMessageResponse` with `toolMetadata`. Both live + reload flow through vm-agent `ExtractMessages` → DO → `chatMessagesToConversationItems` → `matchToolCard`. The direct browser→agent `/agent/ws` (`useProjectAgentSession`) is unused for project chat. `ExtractMessages` is the single fidelity chokepoint. Principle: what passes through Cloudflare should resemble the ACP original.

## Strategy — feature detection over delimiter sniffing
1. **Delimiter-agnostic normalization (hint):** split identifier on `__ / . :`, take last non-empty segment; match on a whole segment against the known tool set (no `sam` substring requirement, no raw substring false positives).
2. **Output-shape validation (authority):** once name-hint matches, derive `DocumentCardData`; render only when renderable (ready/pending/tombstone); on `unavailable` (no usable payload) return null → generic card (Raphaël's "if the JSON is wrong, fall back to default").

## Implementation checklist

### A. Web — recognition + graceful fallback
- [x] `document-card-data.ts`: rewrite `normalizeToolName` to split on `/__|\/|\.|:/` and return last non-empty segment (keep `mcp__` behavior as a subset). Keep `DOCUMENT_CARD_TOOLS` canonical.
- [x] `types.ts`: replace `inferMcpToolNameFromTitle` with a delimiter-agnostic `inferToolNameFromTitle` that returns the title when `normalizeToolName(title)` ∈ `DOCUMENT_CARD_TOOLS` (also keep the legacy `mcp__` check). This makes `legacyDocumentRawOutput(toolName, msg.content)` fire for Codex (reconstruct payload from `content`).
- [x] `registry.ts`: `matchToolCard` — after name match, run `extractDocumentCardData(item)`; return null when `state === 'unavailable'` → generic fallback.
- [x] `DocumentCard.tsx`: remove the now-unreachable `unavailable` render branch (matchToolCard gates it out) to avoid dead code; confirm ready/pending/tombstone tiers intact.

### B. VM agent — fidelity capture
- [x] `message_extract.go`: add package-level `toolNameSepRe = regexp.MustCompile(\`__|/|\.|:\`)` + `normalizeToolNameBase(name)` (last non-empty segment).
- [x] `extractToolName`: keep `claudeCode` primary; broaden title fallback to return the title when `rawCaptureToolNames[normalizeToolNameBase(title)]` OR the legacy `mcp__…__` pattern holds.
- [x] `toolNameNeedsRawCapture`: use `normalizeToolNameBase` so slash/dotted forms match `rawCaptureToolNames`. Keep the name allowlist (data-minimization).
- [x] Keep `rawCaptureToolNames` (Go) in sync with `DOCUMENT_CARD_TOOLS` (web).

## Tests
- [x] TS unit (`document-card-data.test.ts`): `normalizeToolName` for `mcp__`, `/`, `.`, bare, multi-server (`sam-mcp-1/...`) forms.
- [x] TS unit: `matchToolCard` renders DocumentCard for slash Codex item with valid payload; returns null (generic) for malformed payload.
- [x] TS vertical slice (`chatMessagesToConversationItems.test.ts`): Codex `ChatMessageResponse` (slash title, no `toolName`, JSON in `content`, no `rawOutput`) → reconstructs rawOutput → matchToolCard → DocumentCard renderable. Malformed content → generic.
- [x] TS (`DocumentCard.test.tsx`): update for removed `unavailable` branch if asserted.
- [x] Go (`message_extract_toolname_test.go`): table-driven `extractToolName` + `toolNameNeedsRawCapture` for claudeCode meta, `mcp__` title, `sam-mcp/` slash title, dotted, bare, and unrelated (Bash) not captured.
- [x] Playwright visual audit (rule 17): DocumentCard in project chat, mobile 375 + desktop 1280, Codex slash names, long filename, missing mimeType, tombstone; assert no overflow + graceful fallback.

## Acceptance criteria
- [x] Codex `display_from_library` renders the DocumentCard in project chat (live + reload).
- [x] Claude `mcp__` path still renders (no regression).
- [x] Malformed/absent payload falls back to the generic card, never a broken empty card.
- [x] New agent delimiters work with no code change; new library tools require only the two-set update.
- [x] vm-agent captures `toolName` + `rawInput/rawOutput` for Codex library tools (compact-mode inline render).

## Staging (rule 27 — vm-agent change)
Delete all staging nodes → deploy staging → fresh node → NEW Codex project chat → call `display_from_library`, verify DocumentCard renders inline (compact + after reload); verify Claude still works; verify a forced bad payload falls back to generic.

## References
- Rules: 02, 06 (UI-to-backend path), 10, 17, 23, 27, 35
- Idea `01KWVCX19XE0YKE5T6AQMXJTSD`
- Prior PRs: #1488 (typed cards), #1508 (File Preview v2), #1517 (legacy fallback)
