package messagereport

import (
	"encoding/json"
	"math"
	"unicode/utf8"
)

// Transport shaping.
//
// Every outbox row must be deliverable on its own: a request carrying only
// that message has to satisfy the control plane's per-message content limit
// and its request-body limit. Enqueue shapes each message once, before it is
// stored, so nothing in the outbox is rejected for its size.
//
// A message that does not fit is reduced, never dropped, and every reduction
// is explicit in what gets persisted:
//
//  1. Content over the per-message limit keeps its longest prefix that fits,
//     cut on a rune boundary and ending with truncationMarker.
//  2. Tool metadata that still does not fit is replaced by a summary that keeps
//     the tool call's identity, so its card still renders, and records that the
//     output was removed and how large it was. The output text itself stays in
//     the message content.
//  3. If the message still does not fit — content full of characters JSON has
//     to escape, or an enormous tool title — the content is shortened further,
//     and as a last resort the summary keeps only the record of the removal.

const (
	truncationMarker     = "\n\n[truncated]"
	omittedMessageMarker = "[message omitted: exceeded message transport limit]"
)

// transportLimits are the control plane's limits for a single message.
type transportLimits struct {
	contentBytes int // longest content accepted (API MESSAGE_SIZE_THRESHOLD)
	requestBytes int // largest request body accepted (API MAX_MESSAGES_PAYLOAD_BYTES)
}

// transportLimits are the reporter's configured limits, which mirror the
// control plane's.
func (r *Reporter) transportLimits() transportLimits {
	return transportLimits{
		contentBytes: r.cfg.MaxMessageContentBytes,
		requestBytes: r.cfg.BatchMaxBytes,
	}
}

// toolMetadataSummary is what remains of tool metadata too large to send: the
// fields a tool card is keyed on, and a record of what was removed.
// OriginalSizeBytes is the size of the metadata the summary replaced; for a row
// reduced again when sent (omittedForTransport), that is its queued summary.
type toolMetadataSummary struct {
	ToolCallID         string `json:"toolCallId,omitempty"`
	Title              string `json:"title,omitempty"`
	Kind               string `json:"kind,omitempty"`
	Status             string `json:"status,omitempty"`
	ToolName           string `json:"toolName,omitempty"`
	ContentTruncated   bool   `json:"contentTruncated"`
	TransportTruncated bool   `json:"transportTruncated"`
	OriginalSizeBytes  int    `json:"originalSizeBytes"`
}

// fitForTransport returns msg reduced, where necessary, so that a request
// carrying only msg satisfies limits.
func fitForTransport(msg Message, limits transportLimits) Message {
	fitted := msg
	fitted.Content = truncateContent(msg.Content, limits.contentBytes)
	if requestBytes(fitted) <= limits.requestBytes {
		return fitted
	}
	if msg.ToolMetadata != "" {
		fitted.ToolMetadata = summarizeToolMetadata(msg.ToolMetadata)
	}
	shortened, fits := shortenContentToFit(fitted, msg.Content, limits)
	if fits || msg.ToolMetadata == "" {
		return shortened
	}
	fitted.ToolMetadata = truncationRecord(len(msg.ToolMetadata))
	shortened, _ = shortenContentToFit(fitted, msg.Content, limits)
	return shortened
}

// omittedForTransport is the last resort when the control plane rejects, as too
// large, a message that already fits the reporter's own limits: the control
// plane is configured smaller. The marker keeps the message's place, identity
// and role in the transcript.
func omittedForTransport(msg Message) Message {
	msg.Content = omittedMessageMarker
	if msg.ToolMetadata != "" {
		msg.ToolMetadata = truncationRecord(len(msg.ToolMetadata))
	}
	return msg
}

// shortenContentToFit gives msg the longest truncation of original that keeps
// the request within limits. It reports false when even the shortest content,
// the bare truncation marker, does not fit.
func shortenContentToFit(msg Message, original string, limits transportLimits) (Message, bool) {
	withBudget := func(contentBytes int) Message {
		candidate := msg
		candidate.Content = truncateContent(original, contentBytes)
		return candidate
	}
	shortest := min(len(truncationMarker), limits.contentBytes)
	if requestBytes(withBudget(shortest)) > limits.requestBytes {
		return withBudget(shortest), false
	}
	// Request size never shrinks as the content budget grows, so binary-search
	// the largest budget that still fits.
	low, high := shortest, limits.contentBytes
	for low < high {
		mid := low + (high-low+1)/2
		if requestBytes(withBudget(mid)) <= limits.requestBytes {
			low = mid
		} else {
			high = mid - 1
		}
	}
	return withBudget(low), true
}

// truncateContent returns content unchanged when it fits in maxBytes, and
// otherwise its longest rune-aligned prefix followed by truncationMarker,
// together at most maxBytes long.
func truncateContent(content string, maxBytes int) string {
	if len(content) <= maxBytes {
		return content
	}
	if maxBytes <= len(truncationMarker) {
		return truncationMarker[:max(maxBytes, 0)]
	}
	end := maxBytes - len(truncationMarker)
	for end > 0 && !utf8.RuneStart(content[end]) {
		end--
	}
	return content[:end] + truncationMarker
}

// summarizeToolMetadata keeps the identity fields of raw, when it is a JSON
// object that has them, together with the record of the removal.
func summarizeToolMetadata(raw string) string {
	var summary toolMetadataSummary
	// Unreadable metadata keeps no identity; the record of the removal stands alone.
	_ = json.Unmarshal([]byte(raw), &summary)
	summary.ContentTruncated = true
	summary.TransportTruncated = true
	summary.OriginalSizeBytes = len(raw)
	return encodeSummary(summary)
}

// truncationRecord is tool metadata that keeps nothing but the record of the
// removal.
func truncationRecord(originalBytes int) string {
	return encodeSummary(toolMetadataSummary{
		ContentTruncated:   true,
		TransportTruncated: true,
		OriginalSizeBytes:  originalBytes,
	})
}

func encodeSummary(summary toolMetadataSummary) string {
	// A struct of strings, bools and ints always marshals.
	encoded, _ := json.Marshal(summary)
	return string(encoded)
}

// requestBytes is the size of a request body carrying only msg. The outbox row
// ID becomes the message's sequence once it is stored, so it is sized at its
// widest.
func requestBytes(msg Message) int {
	// A message of strings and ints always marshals.
	body, _ := buildBatchPayload([]apiMessage{msg.toAPIMessage(math.MaxInt64)})
	return len(body)
}
