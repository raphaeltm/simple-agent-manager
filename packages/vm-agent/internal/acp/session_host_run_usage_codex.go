package acp

import (
	"bytes"
	"encoding/json"
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

// parseCodexRolloutTokenUsage returns the thread's cumulative token totals
// from the newest `token_count` event in a rollout tail, attributed to the
// newest `turn_context` model in the tail ("" when none is visible). It
// returns nil when the tail has no totals. A Codex thread runs one model at a
// time and the rollout total is not split by model, so a mid-thread model
// switch is attributed to the latest model rather than estimated.
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
