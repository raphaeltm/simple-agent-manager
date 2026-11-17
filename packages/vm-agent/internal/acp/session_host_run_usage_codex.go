package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
)

// Codex run usage (Insights slice U). codex-acp's PromptResponse usage is the
// last model request only, so the thread total is read from the rollout file
// the usage probe already tails: every `token_count` event carries
// `info.total_token_usage`, the thread's running total, and `turn_context`
// lines name the model. The total is cumulative by construction, so it is
// reported as-is under an epoch tied to the thread, and the control plane's
// per-column MAX keeps it safe against repeats and reordering.

type codexTokenUsageTotals struct {
	InputTokens           int64 `json:"input_tokens"`
	CachedInputTokens     int64 `json:"cached_input_tokens"`
	OutputTokens          int64 `json:"output_tokens"`
	ReasoningOutputTokens int64 `json:"reasoning_output_tokens"`
}

type codexTokenCountInfo struct {
	TotalTokenUsage *codexTokenUsageTotals `json:"total_token_usage"`
}

type codexTokenCountTotalsPayload struct {
	Type string               `json:"type"`
	Info *codexTokenCountInfo `json:"info"`
}

type codexTurnContextPayload struct {
	Model string `json:"model"`
}

// codexRolloutTokenUsage reads the thread total and names ONE model for the
// whole thread. The rollout total is not split by model, and the control plane
// keeps one row per (epoch, model), so a name that changed between reports
// (a model switch, or a long turn pushing turn_context out of the tail) would
// store the same cumulative total twice. The session's configured model is
// stable for the thread, so it wins; the rollout model is only the fallback
// when no model was configured, and the first one seen on this host is kept.
func (h *SessionHost) codexRolloutTokenUsage(tail []byte, threadID string) *tokenUsagePayload {
	usage := parseCodexRolloutTokenUsage(tail, threadID)
	if usage == nil {
		return nil
	}
	model := h.loadRunUsageModel()
	if model == "" {
		model = h.rememberCodexRolloutModel(usage.Models[0].Model)
	}
	usage.Models[0].Model = truncateRunUsageModel(model)
	return usage
}

// rememberCodexRolloutModel keeps the first non-empty rollout model this host
// reported and returns the model to report.
func (h *SessionHost) rememberCodexRolloutModel(seen string) string {
	h.runUsage.mu.Lock()
	defer h.runUsage.mu.Unlock()
	if h.runUsage.codexModel == "" {
		h.runUsage.codexModel = seen
	}
	return h.runUsage.codexModel
}

// parseCodexRolloutTokenUsage returns the thread's cumulative token totals
// from the newest `token_count` event in a rollout tail, with the newest
// `turn_context` model in the tail ("" when none is visible). It returns nil
// when the tail has no totals.
func parseCodexRolloutTokenUsage(tail []byte, threadID string) *tokenUsagePayload {
	var totals *codexTokenUsageTotals
	model := ""
	lines := bytes.Split(tail, []byte{'\n'})
	for i := len(lines) - 1; i >= 0 && (totals == nil || model == ""); i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 {
			continue
		}
		var envelope codexRolloutLine
		if err := json.Unmarshal(line, &envelope); err != nil {
			continue
		}
		switch envelope.Type {
		case "turn_context":
			if model != "" {
				continue
			}
			var context codexTurnContextPayload
			if err := json.Unmarshal(envelope.Payload, &context); err == nil {
				model = strings.TrimSpace(context.Model)
			}
		case "event_msg":
			if totals != nil {
				continue
			}
			var payload codexTokenCountTotalsPayload
			if err := json.Unmarshal(envelope.Payload, &payload); err != nil || payload.Type != "token_count" {
				continue
			}
			if payload.Info != nil && payload.Info.TotalTokenUsage != nil {
				totals = payload.Info.TotalTokenUsage
			}
		}
	}
	if totals == nil {
		return nil
	}
	cached := nonNegative(totals.CachedInputTokens)
	reasoning := nonNegative(totals.ReasoningOutputTokens)
	entry := tokenModelPayload{
		Model: model,
		// Codex counts cached input inside input_tokens; SAM's input is fresh input.
		InputTokens:     nonNegative(totals.InputTokens - cached),
		OutputTokens:    nonNegative(totals.OutputTokens),
		CacheReadTokens: cached,
		ReasoningTokens: &reasoning,
	}
	if !tokenEntryHasTokens(entry) {
		return nil
	}
	return &tokenUsagePayload{Epoch: "codex-" + threadID, Models: []tokenModelPayload{entry}}
}

// readCodexRolloutTail returns the trailing bytes of the thread's rollout, or
// ok=false when the thread id is not a UUID or the read failed.
func (h *SessionHost) readCodexRolloutTail(ctx context.Context, threadID string) ([]byte, bool) {
	if !codexThreadIDPattern.MatchString(threadID) {
		slog.Debug("usageProbe: codex thread id is not a UUID, skipping rollout read")
		return nil, false
	}
	reader := h.codexRolloutReader
	if reader == nil {
		reader = h.defaultCodexRolloutTailReader
	}
	tail, err := reader(ctx, threadID)
	if err != nil {
		slog.Debug("usageProbe: codex rollout read failed", "error", err)
		return nil, false
	}
	return tail, true
}
