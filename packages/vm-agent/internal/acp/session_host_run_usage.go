package acp

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"sort"
	"strings"
	"sync"

	acpsdk "github.com/coder/acp-go-sdk"
)

// Run token usage (Insights slice U).
//
// Where each harness reports tokens, for the pinned versions in
// packages/shared/src/agent-install-manifest.json:
//
//   - Claude Code (claude-agent-acp): the ACP PromptResponse carries the turn's
//     tally in `usage` and, per model, in `_meta.quota.model_usage`.
//   - OpenCode: PromptResponse `usage` holds the turn's tally, with no model.
//     It is attributed to the session's configured model.
//   - Codex (codex-acp): PromptResponse `usage` is only the LAST model request
//     of the turn, so it is not used. The thread's cumulative total comes from
//     the rollout file instead (session_host_usage_probe.go).
//   - Any other harness reports nothing, and SAM shows "not reported".
//
// Reports are cumulative. A SessionHost adds each turn into running per-model
// totals under one random epoch and reports the totals, never the increment.
// The control plane stores the larger value per column (agent_run_usage), so a
// retried, duplicated or reordered report cannot count a turn twice, and a lost
// report is restored by the next one. A new host (VM agent restart) starts a
// new epoch whose rows add to the old ones.

const sourceRunUsage = "vm-agent.run_usage"

type tokenModelPayload struct {
	Model            string `json:"model,omitempty"`
	InputTokens      int64  `json:"inputTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens,omitempty"`
	CacheWriteTokens int64  `json:"cacheWriteTokens,omitempty"`
	// ReasoningTokens is nil when the harness does not report reasoning apart
	// from output; zero and "not reported" stay distinct.
	ReasoningTokens *int64 `json:"reasoningTokens,omitempty"`
}

type tokenUsagePayload struct {
	Epoch  string              `json:"epoch"`
	Models []tokenModelPayload `json:"models"`
}

// runUsageAccumulator holds one host's running totals. The zero value is ready.
type runUsageAccumulator struct {
	mu     sync.Mutex
	epoch  string
	models map[string]*tokenModelPayload
}

// add folds one turn's per-model tally into the totals and returns a snapshot
// of the cumulative totals, sorted by model, or ok=false when the turn added
// nothing.
func (a *runUsageAccumulator) add(turn []tokenModelPayload) (tokenUsagePayload, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	added := false
	for _, entry := range turn {
		if !tokenEntryHasTokens(entry) {
			continue
		}
		if a.models == nil {
			a.models = make(map[string]*tokenModelPayload)
		}
		total, ok := a.models[entry.Model]
		if !ok {
			total = &tokenModelPayload{Model: entry.Model}
			a.models[entry.Model] = total
		}
		total.InputTokens += entry.InputTokens
		total.OutputTokens += entry.OutputTokens
		total.CacheReadTokens += entry.CacheReadTokens
		total.CacheWriteTokens += entry.CacheWriteTokens
		if entry.ReasoningTokens != nil {
			sum := *entry.ReasoningTokens
			if total.ReasoningTokens != nil {
				sum += *total.ReasoningTokens
			}
			total.ReasoningTokens = &sum
		}
		added = true
	}
	if !added {
		return tokenUsagePayload{}, false
	}
	if a.epoch == "" {
		a.epoch = newRunUsageEpoch()
	}
	return a.snapshotLocked(), true
}

func (a *runUsageAccumulator) snapshotLocked() tokenUsagePayload {
	names := make([]string, 0, len(a.models))
	for name := range a.models {
		names = append(names, name)
	}
	sort.Strings(names)
	models := make([]tokenModelPayload, 0, len(names))
	for _, name := range names {
		entry := *a.models[name]
		if entry.ReasoningTokens != nil {
			value := *entry.ReasoningTokens
			entry.ReasoningTokens = &value
		}
		models = append(models, entry)
	}
	return tokenUsagePayload{Epoch: a.epoch, Models: models}
}

func tokenEntryHasTokens(entry tokenModelPayload) bool {
	reasoning := int64(0)
	if entry.ReasoningTokens != nil {
		reasoning = *entry.ReasoningTokens
	}
	return entry.InputTokens > 0 || entry.OutputTokens > 0 || entry.CacheReadTokens > 0 ||
		entry.CacheWriteTokens > 0 || reasoning > 0
}

func newRunUsageEpoch() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand does not fail on supported platforms; an empty epoch would
		// be rejected by the control plane, so fall back to a fixed marker.
		return "host-epoch"
	}
	return "host-" + hex.EncodeToString(buf)
}

func (h *SessionHost) storeRunUsageModel(settings *agentSettingsPayload) {
	model := ""
	if settings != nil {
		model = strings.TrimSpace(settings.Model)
	}
	h.runUsageModel.Store(model)
}

func (h *SessionHost) loadRunUsageModel() string {
	if v, ok := h.runUsageModel.Load().(string); ok {
		return v
	}
	return ""
}

// recordPromptTokenUsage folds one completed (or cancelled) turn's tokens into
// the host's totals and reports the totals. Codex is skipped: its prompt usage
// is the last request only, and its thread totals come from the rollout probe.
func (h *SessionHost) recordPromptTokenUsage(resp acpsdk.PromptResponse) {
	attr, hasAttr := h.credentialAttributionSnapshot()
	if hasAttr && attr.AgentType == "openai-codex" {
		return
	}
	turn := promptTurnTokenUsage(resp, h.loadRunUsageModel())
	if len(turn) == 0 {
		return
	}
	usage, ok := h.runUsage.add(turn)
	if !ok {
		return
	}
	h.enqueueTokenUsageReport(attr, hasAttr, usage)
}

func (h *SessionHost) enqueueTokenUsageReport(attr credentialAttribution, hasAttr bool, usage tokenUsagePayload) {
	request, ok := h.buildUsageReportRequest(attr, hasAttr, sourceRunUsage, h.now().UnixMilli(), nil)
	if !ok {
		slog.Debug("runUsage: report not built (missing routing or credential attribution)")
		return
	}
	request.payload.TokenUsage = &usage
	h.enqueueUsageReport(request)
}

type quotaTokenCount struct {
	InputTokens           *int64 `json:"inputTokens"`
	CachedInputTokens     *int64 `json:"cachedInputTokens"`
	CachedWriteTokens     *int64 `json:"cachedWriteTokens"`
	OutputTokens          *int64 `json:"outputTokens"`
	ReasoningOutputTokens *int64 `json:"reasoningOutputTokens"`
}

type quotaModelUsage struct {
	Model      string          `json:"model"`
	TokenCount quotaTokenCount `json:"token_count"`
}

type promptQuotaMeta struct {
	ModelUsage []quotaModelUsage `json:"model_usage"`
}

// promptTurnTokenUsage reads one turn's tokens from an ACP prompt response:
// the per-model `_meta.quota.model_usage` when present (Claude Code), else the
// turn `usage` attributed to fallbackModel (OpenCode). Nothing is estimated.
func promptTurnTokenUsage(resp acpsdk.PromptResponse, fallbackModel string) []tokenModelPayload {
	if perModel := quotaModelTokenUsage(resp.Meta); len(perModel) > 0 {
		return perModel
	}
	if resp.Usage == nil {
		return nil
	}
	entry := tokenModelPayload{
		Model:        fallbackModel,
		InputTokens:  nonNegative(int64(resp.Usage.InputTokens)),
		OutputTokens: nonNegative(int64(resp.Usage.OutputTokens)),
	}
	if resp.Usage.CachedReadTokens != nil {
		entry.CacheReadTokens = nonNegative(int64(*resp.Usage.CachedReadTokens))
	}
	if resp.Usage.CachedWriteTokens != nil {
		entry.CacheWriteTokens = nonNegative(int64(*resp.Usage.CachedWriteTokens))
	}
	if resp.Usage.ThoughtTokens != nil {
		value := nonNegative(int64(*resp.Usage.ThoughtTokens))
		entry.ReasoningTokens = &value
	}
	if !tokenEntryHasTokens(entry) {
		return nil
	}
	return []tokenModelPayload{entry}
}

func quotaModelTokenUsage(meta map[string]any) []tokenModelPayload {
	raw, ok := meta["quota"]
	if !ok {
		return nil
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var quota promptQuotaMeta
	if err := json.Unmarshal(encoded, &quota); err != nil {
		return nil
	}
	entries := make([]tokenModelPayload, 0, len(quota.ModelUsage))
	for _, usage := range quota.ModelUsage {
		count := usage.TokenCount
		entry := tokenModelPayload{
			Model:            strings.TrimSpace(usage.Model),
			InputTokens:      derefNonNegative(count.InputTokens),
			OutputTokens:     derefNonNegative(count.OutputTokens),
			CacheReadTokens:  derefNonNegative(count.CachedInputTokens),
			CacheWriteTokens: derefNonNegative(count.CachedWriteTokens),
		}
		// Claude Code counts reasoning inside output and reports 0 here; only a
		// positive value is a separate measurement.
		if count.ReasoningOutputTokens != nil && *count.ReasoningOutputTokens > 0 {
			value := *count.ReasoningOutputTokens
			entry.ReasoningTokens = &value
		}
		if tokenEntryHasTokens(entry) {
			entries = append(entries, entry)
		}
	}
	return entries
}

func nonNegative(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

func derefNonNegative(value *int64) int64 {
	if value == nil {
		return 0
	}
	return nonNegative(*value)
}
