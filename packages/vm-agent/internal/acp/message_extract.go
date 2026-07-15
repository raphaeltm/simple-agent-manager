package acp

import (
	"encoding/json"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"
)

// toolNameSepRe matches the namespace separators different agent adapters use to
// prefix a tool identifier: Claude `mcp__<server>__<tool>` (double underscore),
// Codex `<server>/<tool>` (slash), and `.`/`:` used by others. Single `_` is NOT
// a separator (it is common inside tool names, e.g. display_from_library). Mirror
// of the web normalizeToolName separator set.
var toolNameSepRe = regexp.MustCompile(`__|/|\.|:`)

// normalizeToolNameBase reduces a raw tool identifier to its base tool name,
// independent of the agent's separator convention. Splits on any known separator
// and returns the last non-empty segment (or the input unchanged when there is
// none). Delimiter-agnostic so new adapter conventions work without new code.
func normalizeToolNameBase(name string) string {
	parts := toolNameSepRe.Split(name, -1)
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] != "" {
			return parts[i]
		}
	}
	return name
}

// maxToolContentSize is the maximum size (in bytes) for diff oldText/newText
// fields to prevent excessive storage. Configurable via MAX_TOOL_CONTENT_SIZE.
var maxToolContentSize = func() int {
	if v := os.Getenv("MAX_TOOL_CONTENT_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 100 * 1024 // 100KB default
}()

// maxToolRawFieldSize is the maximum serialized size (in bytes) for the
// rawInput/rawOutput fields captured into ToolMeta. These fields carry the
// card-critical metadata (fileId, filename, mimeType, sizeBytes, caption) that
// typed tool-call cards need, and unlike Content they survive compact-mode
// stripping. Large raw payloads (file contents, command output) exceed this cap
// and are omitted so tool metadata stays lean. Configurable via
// MAX_TOOL_RAW_FIELD_SIZE.
var maxToolRawFieldSize = func() int {
	if v := os.Getenv("MAX_TOOL_RAW_FIELD_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 16 * 1024 // 16KB default
}()

// ExtractedMessage represents a chat message extracted from an ACP
// SessionNotification for persistence to the control plane.
type ExtractedMessage struct {
	MessageID    string `json:"messageId"`
	Role         string `json:"role"`
	Content      string `json:"content"`
	ToolMetadata string `json:"toolMetadata,omitempty"` // JSON string
	// Origin is "system" when the source ACP block carried the SAM system-injected
	// marker (_meta["sam.origin"]="system"); empty otherwise. The control plane
	// persists it so the UI can collapse injected content.
	Origin string `json:"origin,omitempty"`
}

// MetaOriginKey is the ACP content-block _meta key SAM uses to mark a prompt
// block as system-injected. OriginSystem is its value for injected content.
const (
	MetaOriginKey = "sam.origin"
	OriginSystem  = "system"
)

// stripInjectedOriginMarker removes the SAM system-origin marker from prompt
// blocks that did not arrive from a trusted control-plane source. Browser viewer
// prompts must not be able to mark their own content as origin=system, which
// would hide it from search, dedup, topic inference, and attention. The blocks
// are freshly constructed per request (see parsePromptBlocks), so mutating their
// Meta maps in place is safe and shares nothing.
func stripInjectedOriginMarker(blocks []acpsdk.ContentBlock) {
	for _, b := range blocks {
		if b.Text != nil && b.Text.Meta != nil {
			delete(b.Text.Meta, MetaOriginKey)
		}
	}
}

// contentBlockOrigin returns the SAM origin marker from a content block's _meta,
// or "" when absent/not a string. Safe on a nil Text pointer / nil Meta map.
func contentBlockOrigin(block acpsdk.ContentBlock) string {
	if block.Text == nil {
		return ""
	}
	if v, ok := block.Text.Meta[MetaOriginKey]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// ToolMeta holds structured tool call metadata serialized as JSON into
// the ToolMetadata field of ExtractedMessage.
type ToolMeta struct {
	ToolCallId string `json:"toolCallId,omitempty"`
	Title      string `json:"title,omitempty"`
	Kind       string `json:"kind,omitempty"`
	Status     string `json:"status,omitempty"`
	// ToolName is the stable, machine-readable tool identifier (e.g.
	// "mcp__sam-mcp__upload_to_library" or "Read"). Unlike Title (a
	// human-readable, mutable string), ToolName is a durable discriminator that
	// typed tool-call cards match on. Sourced from the ACP _meta.claudeCode
	// extension when present, with a fallback that recognizes the mcp__<server>__
	// <tool> title convention used by non-Claude adapters.
	ToolName  string `json:"toolName,omitempty"`
	Locations []struct {
		Path string `json:"path,omitempty"`
		Line *int   `json:"line,omitempty"`
	} `json:"locations,omitempty"`
	// Content stores each ACP ToolCallContent block as raw JSON, preserving
	// the exact wire format the frontend expects (including type discriminator,
	// nested content blocks, and all fields). This ensures the persisted path
	// produces the same shape as the real-time ACP WebSocket path.
	Content []json.RawMessage `json:"content,omitempty"`
	// RawInput/RawOutput carry the tool's raw input parameters and raw result.
	// They hold the card-critical fields (fileId, filename, mimeType, sizeBytes,
	// caption) and — unlike Content — are NOT stripped in compact mode, so typed
	// cards can render from durable metadata after reload. Size-capped via
	// maxToolRawFieldSize; oversized payloads are omitted.
	RawInput  json.RawMessage `json:"rawInput,omitempty"`
	RawOutput json.RawMessage `json:"rawOutput,omitempty"`
}

// ExtractMessages converts an ACP SessionNotification into zero or more
// ExtractedMessage values suitable for the message reporter.
//
// Extracts user/assistant text chunks, tool calls, thinking blocks, and
// plan updates for persistence to the control plane.
func ExtractMessages(notif acpsdk.SessionNotification) []ExtractedMessage {
	u := notif.Update
	var msgs []ExtractedMessage

	// User message chunk → role "user"
	if u.UserMessageChunk != nil {
		text := extractContentBlockText(u.UserMessageChunk.Content)
		if text != "" {
			msgs = append(msgs, ExtractedMessage{
				MessageID: uuid.NewString(),
				Role:      "user",
				Content:   text,
				Origin:    contentBlockOrigin(u.UserMessageChunk.Content),
			})
		}
	}

	// Agent message chunk → role "assistant"
	if u.AgentMessageChunk != nil {
		text := extractContentBlockText(u.AgentMessageChunk.Content)
		if text != "" {
			msgs = append(msgs, ExtractedMessage{
				MessageID: uuid.NewString(),
				Role:      "assistant",
				Content:   text,
			})
		}
	}

	// Agent thought chunk → role "thinking"
	if u.AgentThoughtChunk != nil {
		text := extractContentBlockText(u.AgentThoughtChunk.Content)
		if text != "" {
			msgs = append(msgs, ExtractedMessage{
				MessageID: uuid.NewString(),
				Role:      "thinking",
				Content:   text,
			})
		}
	}

	// Plan update → role "plan"
	if u.Plan != nil {
		planJSON, err := json.Marshal(u.Plan.Entries)
		if err == nil && len(u.Plan.Entries) > 0 {
			msgs = append(msgs, ExtractedMessage{
				MessageID: uuid.NewString(),
				Role:      "plan",
				Content:   string(planJSON),
			})
		}
	}

	// Tool call → role "tool"
	if u.ToolCall != nil {
		content := extractToolCallContents(u.ToolCall.Content)
		normalized := normalizeRawToolOutput(u.ToolCall.RawOutput)
		meta := ToolMeta{
			ToolCallId: string(u.ToolCall.ToolCallId),
			Title:      u.ToolCall.Title,
			Kind:       string(u.ToolCall.Kind),
			Status:     string(u.ToolCall.Status),
			ToolName:   extractToolName(u.ToolCall.Meta, u.ToolCall.Title),
			Content:    marshalRawContent(u.ToolCall.Content),
		}
		if content == "" && len(normalized.content) > 0 {
			meta.Content = append(meta.Content, normalized.content...)
			content = normalized.text
		}
		if toolNameNeedsRawCapture(meta.ToolName) {
			meta.RawInput = marshalRawField(u.ToolCall.RawInput)
			meta.RawOutput = marshalRawField(u.ToolCall.RawOutput)
		}
		for _, loc := range u.ToolCall.Locations {
			meta.Locations = append(meta.Locations, struct {
				Path string `json:"path,omitempty"`
				Line *int   `json:"line,omitempty"`
			}{Path: loc.Path, Line: loc.Line})
		}
		metaJSON, _ := json.Marshal(meta)

		if content == "" {
			content = "(tool call)"
		}
		msgs = append(msgs, ExtractedMessage{
			MessageID:    uuid.NewString(),
			Role:         "tool",
			Content:      content,
			ToolMetadata: string(metaJSON),
		})
	}

	// Tool call update → role "tool" (status update)
	if u.ToolCallUpdate != nil {
		content := extractToolCallContents(u.ToolCallUpdate.Content)
		normalized := normalizeRawToolOutput(u.ToolCallUpdate.RawOutput)
		meta := ToolMeta{
			ToolCallId: string(u.ToolCallUpdate.ToolCallId),
			Content:    marshalRawContent(u.ToolCallUpdate.Content),
		}
		if content == "" && len(normalized.content) > 0 {
			meta.Content = append(meta.Content, normalized.content...)
			content = normalized.text
		}
		var updateTitle string
		if u.ToolCallUpdate.Title != nil {
			updateTitle = *u.ToolCallUpdate.Title
		}
		meta.ToolName = extractToolName(u.ToolCallUpdate.Meta, updateTitle)
		if toolNameNeedsRawCapture(meta.ToolName) {
			meta.RawInput = marshalRawField(u.ToolCallUpdate.RawInput)
			meta.RawOutput = marshalRawField(u.ToolCallUpdate.RawOutput)
		}
		if u.ToolCallUpdate.Title != nil {
			meta.Title = *u.ToolCallUpdate.Title
		}
		if u.ToolCallUpdate.Kind != nil {
			meta.Kind = string(*u.ToolCallUpdate.Kind)
		}
		if u.ToolCallUpdate.Status != nil {
			meta.Status = string(*u.ToolCallUpdate.Status)
		}
		for _, loc := range u.ToolCallUpdate.Locations {
			meta.Locations = append(meta.Locations, struct {
				Path string `json:"path,omitempty"`
				Line *int   `json:"line,omitempty"`
			}{Path: loc.Path, Line: loc.Line})
		}

		// Only emit a message if there is meaningful content or a status change.
		if content != "" || meta.Status != "" {
			metaJSON, _ := json.Marshal(meta)
			if content == "" {
				content = "(tool update)"
			}
			msgs = append(msgs, ExtractedMessage{
				MessageID:    uuid.NewString(),
				Role:         "tool",
				Content:      content,
				ToolMetadata: string(metaJSON),
			})
		}
	}

	return msgs
}

// extractContentBlockText extracts text from a ContentBlock.
// Returns empty string if the block is not a text block.
func extractContentBlockText(block acpsdk.ContentBlock) string {
	if block.Text != nil {
		return block.Text.Text
	}
	return ""
}

// truncateContent truncates text to maxToolContentSize bytes, appending
// a marker if truncated. It ensures the cut point falls on a valid UTF-8
// boundary to avoid producing garbled output.
func truncateContent(s string) string {
	if len(s) <= maxToolContentSize {
		return s
	}
	// Walk backwards from the limit to find a valid UTF-8 boundary.
	truncated := s[:maxToolContentSize]
	for len(truncated) > 0 && !utf8.ValidString(truncated) {
		truncated = truncated[:len(truncated)-1]
	}
	return truncated + "\n... [truncated]"
}

// marshalRawContent serializes ACP tool call content blocks to raw JSON,
// preserving the exact ACP wire format. This ensures the persisted path
// produces the same shape as the real-time ACP WebSocket path.
// Large diff fields (oldText/newText) are truncated before marshaling.
func marshalRawContent(contents []acpsdk.ToolCallContent) []json.RawMessage {
	var items []json.RawMessage
	for _, c := range contents {
		// Truncate large diff fields before marshaling to prevent
		// excessive storage while preserving the full structure.
		// Copy the struct to preserve all fields (including _meta).
		if c.Diff != nil {
			diffCopy := *c.Diff
			diffCopy.NewText = truncateContent(c.Diff.NewText)
			if c.Diff.OldText != nil {
				t := truncateContent(*c.Diff.OldText)
				diffCopy.OldText = &t
			}
			c.Diff = &diffCopy
		}
		raw, err := json.Marshal(c)
		// Skip zero-variant items: SDK returns empty []byte when all
		// variant pointers are nil; also catches degenerate "{}" objects.
		if err == nil && len(raw) > 2 {
			items = append(items, raw)
		}
	}
	return items
}

// extractToolName resolves the stable tool identifier for a tool call.
//
// Primary source: the ACP `_meta.claudeCode.toolName` extension, which the
// claude-agent-acp adapter sets on both the initial tool_call and every
// tool_call_update.
//
// Title fallback (adapters that set no claudeCode toolName, e.g. Codex): the
// tool identifier arrives as the ACP title using the adapter's own separator —
// Claude `mcp__<server>__<tool>`, Codex `<server>/<tool>`. We claim the title as
// the toolName when it normalizes to one of our known typed-card tools
// (delimiter-agnostic), or when it follows the legacy mcp__ convention. Scoping
// the first branch to known tools avoids mistaking an arbitrary human title for
// a tool identifier. Returns "" when nothing yields a name.
func extractToolName(meta map[string]any, title string) string {
	if cc, ok := meta["claudeCode"].(map[string]any); ok {
		if name, ok := cc["toolName"].(string); ok && name != "" {
			return name
		}
	}
	if title == "" {
		return ""
	}
	if rawCaptureToolNames[normalizeToolNameBase(title)] {
		return title
	}
	// Legacy mcp__<server>__<tool> convention (any tool, not just library ones).
	if strings.HasPrefix(title, "mcp__") && strings.Count(title, "__") >= 2 {
		return title
	}
	return ""
}

// rawCaptureToolNames is the set of base tool names (separator-agnostic, see
// normalizeToolNameBase) whose rawInput/rawOutput are captured into ToolMeta.
// Restricting capture to the tools that render typed cards keeps other tools'
// arguments — Bash command strings, Write file contents — out of persisted chat
// metadata (data minimization: those would otherwise survive compact-mode
// stripping and be returned in every chat load).
//
// Keep in sync with DOCUMENT_CARD_TOOLS in
// apps/web/src/components/project-message-view/tool-cards/document-card-data.ts.
var rawCaptureToolNames = map[string]bool{
	"upload_to_library":    true,
	"replace_library_file": true,
	"display_from_library": true,
}

// toolNameNeedsRawCapture reports whether a tool's raw input/output should be
// persisted for card rendering. Matches on the base tool name using the
// delimiter-agnostic normalizer, so every adapter's separator convention
// (mcp__, /, ., :) resolves to the same base name.
func toolNameNeedsRawCapture(toolName string) bool {
	return rawCaptureToolNames[normalizeToolNameBase(toolName)]
}

// marshalRawField serializes a tool's raw input/output value to JSON for
// storage in ToolMeta. Returns nil (omitted from the metadata) when the value
// is absent, cannot be marshaled, or exceeds maxToolRawFieldSize. Empty objects
// ({}) and arrays ([]) marshal to 2 bytes and are also treated as absent. The
// size cap keeps tool metadata lean: small results (library tool payloads) are
// kept, large ones are dropped. Unlike Content, this is not truncated — a
// partial JSON value would be unparseable — so it is stored whole or not at all.
func marshalRawField(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	raw, err := json.Marshal(v)
	if err != nil || len(raw) <= 2 || len(raw) > maxToolRawFieldSize {
		return nil
	}
	return raw
}

// extractToolCallContents aggregates text from tool call content blocks.
func extractToolCallContents(contents []acpsdk.ToolCallContent) string {
	var text string
	for _, c := range contents {
		if c.Content != nil && c.Content.Content.Text != nil {
			if text != "" {
				text += "\n"
			}
			text += c.Content.Content.Text.Text
		}
		if c.Diff != nil {
			if text != "" {
				text += "\n"
			}
			text += "diff: " + c.Diff.Path
		}
	}
	return text
}
