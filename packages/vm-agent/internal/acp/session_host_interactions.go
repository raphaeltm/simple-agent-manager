package acp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"
)

const (
	acpInteractionProtocolVersion = 1
)

// AcpInteractionRuntimeConfig is the versioned Worker -> vm-agent start contract.
// A missing or disabled contract always fails closed.
type AcpInteractionRuntimeConfig struct {
	Enabled              bool  `json:"enabled"`
	ProtocolVersion      int   `json:"protocolVersion"`
	PermissionDeadlineMs int64 `json:"permissionDeadlineMs"`
	MaxDeadlineMs        int64 `json:"maxDeadlineMs"`
	DeadlineMarginMs     int64 `json:"deadlineMarginMs"`
	RequestMaxBytes      int   `json:"requestMaxBytes"`
	OptionsMaxCount      int   `json:"optionsMaxCount"`
	OptionIDMaxChars     int   `json:"optionIdMaxChars"`
	OptionNameMaxChars   int   `json:"optionNameMaxChars"`
	ReceiptLimit         int   `json:"receiptLimit"`
	ResponseMaxBytes     int64 `json:"responseMaxBytes"`
	SettleRetryDelaysMs  []int `json:"settleRetryDelaysMs"`
	SettleRetrySteadyMs  int   `json:"settleRetrySteadyMs"`
}

func (c AcpInteractionRuntimeConfig) validate() error {
	if !c.Enabled {
		return nil
	}
	if c.ProtocolVersion != acpInteractionProtocolVersion {
		return fmt.Errorf("unsupported ACP interaction protocol version %d", c.ProtocolVersion)
	}
	if c.PermissionDeadlineMs <= 0 || c.MaxDeadlineMs <= 0 || c.DeadlineMarginMs < 0 ||
		c.PermissionDeadlineMs > c.MaxDeadlineMs {
		return errors.New("invalid ACP interaction deadline configuration")
	}
	if c.RequestMaxBytes <= 0 || c.OptionsMaxCount <= 0 || c.OptionIDMaxChars <= 0 ||
		c.OptionNameMaxChars <= 0 || c.ReceiptLimit <= 0 || c.ResponseMaxBytes <= 0 ||
		c.SettleRetrySteadyMs <= 0 {
		return errors.New("invalid ACP interaction bounds")
	}
	for _, delay := range c.SettleRetryDelaysMs {
		if delay <= 0 {
			return errors.New("invalid ACP interaction settle retry delay")
		}
	}
	return nil
}

// ValidateAcpInteractionRuntimeConfig validates an inbound session-start contract.
func ValidateAcpInteractionRuntimeConfig(config AcpInteractionRuntimeConfig) error {
	return config.validate()
}

type acpPermissionOption struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type acpPermissionDetail struct {
	ToolCallID string                `json:"toolCallId"`
	Title      string                `json:"title,omitempty"`
	ToolKind   string                `json:"toolKind,omitempty"`
	Options    []acpPermissionOption `json:"options"`
}

type acpInteractionCreateRequest struct {
	ProtocolVersion int                 `json:"protocolVersion"`
	InteractionID   string              `json:"interactionId"`
	Generation      string              `json:"generation"`
	RuntimeIdentity string              `json:"runtimeIdentity"`
	AgentSessionID  string              `json:"agentSessionId"`
	Kind            string              `json:"kind"`
	PayloadHash     string              `json:"payloadHash"`
	Detail          acpPermissionDetail `json:"detail"`
	SafeSummary     struct {
		ToolCallID  string `json:"toolCallId,omitempty"`
		OptionCount int    `json:"optionCount"`
	} `json:"safeSummary"`
	DeadlineAt int64 `json:"deadlineAt"`
}

type acpInteractionSettleRequest struct {
	ProtocolVersion int    `json:"protocolVersion"`
	InteractionID   string `json:"interactionId"`
	Generation      string `json:"generation"`
	RuntimeIdentity string `json:"runtimeIdentity"`
	AgentSessionID  string `json:"agentSessionId"`
	Reason          string `json:"reason"`
}

// AcpInteractionAnswerDecision is the bounded decision subset used by permissions.
type AcpInteractionAnswerDecision struct {
	Kind       string `json:"kind"`
	OptionID   string `json:"optionId,omitempty"`
	AnswerHash string `json:"answerHash"`
}

// ValidatePermissionAcpInteractionDecision mirrors the shared permission answer
// boundary without accepting form or URL decision shapes.
func ValidatePermissionAcpInteractionDecision(decision AcpInteractionAnswerDecision) error {
	decodedHash, err := hex.DecodeString(decision.AnswerHash)
	if err != nil || len(decodedHash) != sha256.Size {
		return errors.New("answerHash must be a SHA-256 hex digest")
	}
	switch decision.Kind {
	case "selected_option":
		if strings.TrimSpace(decision.OptionID) == "" {
			return errors.New("selected_option requires optionId")
		}
	case "declined", "cancelled":
		if decision.OptionID != "" {
			return errors.New("cancel decision must not include optionId")
		}
	default:
		return errors.New("unsupported permission decision kind")
	}
	return nil
}

type acpInteractionWaitResult struct {
	optionID string
	cancel   bool
	reason   string
}

type acpInteractionWaiter struct {
	generation string
	options    map[string]struct{}
	result     chan acpInteractionWaitResult
}

type acpInteractionReceipt struct {
	generation   string
	decisionHash string
}

func (h *SessionHost) configureAcpInteractions(config AcpInteractionRuntimeConfig) {
	h.interactionMu.Lock()
	defer h.interactionMu.Unlock()
	h.interactionConfig = config
}

// ConfigureAcpInteractions applies the trusted session-start contract before the
// ACP process attaches. Invalid enabled contracts are rejected by the caller.
func (h *SessionHost) ConfigureAcpInteractions(config AcpInteractionRuntimeConfig) {
	h.configureAcpInteractions(config)
}

func (h *SessionHost) acpInteractionConfigSnapshot() AcpInteractionRuntimeConfig {
	h.interactionMu.Lock()
	defer h.interactionMu.Unlock()
	config := h.interactionConfig
	config.SettleRetryDelaysMs = append([]int(nil), config.SettleRetryDelaysMs...)
	return config
}

func (h *SessionHost) attachAcpInteractionGeneration() string {
	generation := uuid.NewString()
	h.interactionMu.Lock()
	h.cancelInteractionWaitersLocked("connection_replaced")
	h.interactionGeneration = generation
	h.interactionMu.Unlock()
	return generation
}

func (h *SessionHost) cancelInteractionWaiters(reason string) {
	h.interactionMu.Lock()
	defer h.interactionMu.Unlock()
	h.cancelInteractionWaitersLocked(reason)
}

func (h *SessionHost) cancelInteractionWaitersLocked(reason string) {
	for interactionID, waiter := range h.interactionWaiters {
		delete(h.interactionWaiters, interactionID)
		waiter.result <- acpInteractionWaitResult{cancel: true, reason: reason}
	}
}

func (h *SessionHost) registerInteractionWaiter(
	interactionID string,
	generation string,
	options map[string]struct{},
) (*acpInteractionWaiter, error) {
	h.interactionMu.Lock()
	defer h.interactionMu.Unlock()
	if !h.interactionConfig.Enabled || generation == "" || generation != h.interactionGeneration {
		return nil, errors.New("ACP interaction generation is not active")
	}
	if _, exists := h.interactionWaiters[interactionID]; exists {
		return nil, errors.New("ACP interaction waiter already exists")
	}
	waiter := &acpInteractionWaiter{
		generation: generation,
		options:    options,
		result:     make(chan acpInteractionWaitResult, 1),
	}
	h.interactionWaiters[interactionID] = waiter
	return waiter, nil
}

// CancelAcpInteractionWaiter removes one waiter if cancellation wins the race.
// A false result means an answer or lifecycle cancellation already claimed it.
func (h *SessionHost) cancelAcpInteractionWaiter(interactionID, generation, reason string) bool {
	h.interactionMu.Lock()
	defer h.interactionMu.Unlock()
	waiter, ok := h.interactionWaiters[interactionID]
	if !ok || waiter.generation != generation {
		return false
	}
	delete(h.interactionWaiters, interactionID)
	waiter.result <- acpInteractionWaitResult{cancel: true, reason: reason}
	return true
}

func canonicalDecisionHash(decision AcpInteractionAnswerDecision) string {
	encoded, _ := json.Marshal(decision)
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

func (h *SessionHost) rememberInteractionReceiptLocked(
	interactionID string,
	receipt acpInteractionReceipt,
) {
	if _, exists := h.interactionReceipts[interactionID]; !exists {
		h.interactionReceiptOrder = append(h.interactionReceiptOrder, interactionID)
	}
	h.interactionReceipts[interactionID] = receipt
	limit := h.interactionConfig.ReceiptLimit
	for len(h.interactionReceiptOrder) > limit {
		evicted := h.interactionReceiptOrder[0]
		h.interactionReceiptOrder = h.interactionReceiptOrder[1:]
		delete(h.interactionReceipts, evicted)
	}
}

// ResolveAcpInteractionAnswer consumes a trusted Worker answer without creating
// work. It is intentionally only an in-memory registry lookup.
func (h *SessionHost) ResolveAcpInteractionAnswer(
	interactionID string,
	generation string,
	decision AcpInteractionAnswerDecision,
) string {
	h.interactionMu.Lock()
	defer h.interactionMu.Unlock()
	if h.interactionGeneration == "" {
		return "no_waiter"
	}
	if generation == "" || generation != h.interactionGeneration {
		return "stale_generation"
	}
	decisionHash := canonicalDecisionHash(decision)
	if receipt, exists := h.interactionReceipts[interactionID]; exists {
		if receipt.generation != generation {
			return "stale_generation"
		}
		if receipt.decisionHash == decisionHash {
			return "duplicate"
		}
		return "conflict"
	}
	waiter, exists := h.interactionWaiters[interactionID]
	if !exists {
		return "no_waiter"
	}
	if waiter.generation != generation {
		return "stale_generation"
	}
	result := acpInteractionWaitResult{}
	switch decision.Kind {
	case "selected_option":
		if _, allowed := waiter.options[decision.OptionID]; !allowed {
			return "conflict"
		}
		result.optionID = decision.OptionID
	case "declined", "cancelled":
		result.cancel = true
		result.reason = "completed"
	default:
		return "conflict"
	}
	delete(h.interactionWaiters, interactionID)
	h.rememberInteractionReceiptLocked(interactionID, acpInteractionReceipt{
		generation: generation, decisionHash: decisionHash,
	})
	waiter.result <- result
	return "consumed"
}

func (h *SessionHost) permissionDeadline(ctx context.Context, config AcpInteractionRuntimeConfig) (time.Time, bool) {
	now := h.now()
	duration := time.Duration(config.PermissionDeadlineMs) * time.Millisecond
	maxDuration := time.Duration(config.MaxDeadlineMs) * time.Millisecond
	if duration > maxDuration {
		duration = maxDuration
	}
	deadline := now.Add(duration)
	if promptDeadline, ok := ctx.Deadline(); ok {
		promptDeadline = promptDeadline.Add(-time.Duration(config.DeadlineMarginMs) * time.Millisecond)
		if !promptDeadline.After(now) {
			return time.Time{}, false
		}
		if promptDeadline.Before(deadline) {
			deadline = promptDeadline
		}
	}
	return deadline, true
}

func permissionDetail(
	params acpsdk.RequestPermissionRequest,
	config AcpInteractionRuntimeConfig,
) (acpPermissionDetail, map[string]struct{}, error) {
	if len(params.Options) == 0 || len(params.Options) > config.OptionsMaxCount {
		return acpPermissionDetail{}, nil, errors.New("permission options are empty or exceed the configured limit")
	}
	detail := acpPermissionDetail{ToolCallID: string(params.ToolCall.ToolCallId)}
	if params.ToolCall.Title != nil {
		detail.Title = *params.ToolCall.Title
	}
	if params.ToolCall.Kind != nil {
		detail.ToolKind = string(*params.ToolCall.Kind)
	}
	detail.Options = make([]acpPermissionOption, 0, len(params.Options))
	optionIDs := make(map[string]struct{}, len(params.Options))
	for _, option := range params.Options {
		id := string(option.OptionId)
		kind := string(option.Kind)
		if id == "" || len([]rune(id)) > config.OptionIDMaxChars {
			return acpPermissionDetail{}, nil, errors.New("permission option id is invalid")
		}
		if option.Name == "" || len([]rune(option.Name)) > config.OptionNameMaxChars {
			return acpPermissionDetail{}, nil, errors.New("permission option name is invalid")
		}
		switch option.Kind {
		case acpsdk.PermissionOptionKindAllowOnce, acpsdk.PermissionOptionKindAllowAlways,
			acpsdk.PermissionOptionKindRejectOnce, acpsdk.PermissionOptionKindRejectAlways:
		default:
			return acpPermissionDetail{}, nil, errors.New("permission option kind is unsupported")
		}
		if _, duplicate := optionIDs[id]; duplicate {
			return acpPermissionDetail{}, nil, errors.New("permission option ids must be unique")
		}
		optionIDs[id] = struct{}{}
		detail.Options = append(detail.Options, acpPermissionOption{ID: id, Kind: kind, Name: option.Name})
	}
	encoded, err := json.Marshal(detail)
	if err != nil || len(encoded) > config.RequestMaxBytes {
		return acpPermissionDetail{}, nil, errors.New("permission detail exceeds the configured limit")
	}
	return detail, optionIDs, nil
}

func cancelledPermissionResponse() acpsdk.RequestPermissionResponse {
	return acpsdk.RequestPermissionResponse{
		Outcome: acpsdk.NewRequestPermissionOutcomeCancelled(),
	}
}

func (h *SessionHost) requestPermission(
	ctx context.Context,
	generation string,
	params acpsdk.RequestPermissionRequest,
) (acpsdk.RequestPermissionResponse, error) {
	config := h.acpInteractionConfigSnapshot()
	if !config.Enabled || config.validate() != nil || generation == "" ||
		h.config.ProjectID == "" || h.config.WorkspaceID == "" || h.config.SessionID == "" ||
		h.config.RuntimeIdentity == "" || h.config.CallbackToken == "" || h.config.ControlPlaneURL == "" {
		slog.Info("acp_interaction.permission_cancelled", "reason", "unsupported")
		return cancelledPermissionResponse(), nil
	}
	deadline, ok := h.permissionDeadline(ctx, config)
	if !ok {
		slog.Info("acp_interaction.permission_cancelled", "reason", "deadline_elapsed")
		return cancelledPermissionResponse(), nil
	}
	detail, optionIDs, err := permissionDetail(params, config)
	if err != nil {
		slog.Info("acp_interaction.permission_cancelled", "reason", "invalid_request")
		return cancelledPermissionResponse(), nil
	}
	interactionID := uuid.NewString()
	request := acpInteractionCreateRequest{
		ProtocolVersion: acpInteractionProtocolVersion,
		InteractionID:   interactionID,
		Generation:      generation,
		RuntimeIdentity: h.config.RuntimeIdentity,
		AgentSessionID:  h.config.SessionID,
		Kind:            "permission",
		Detail:          detail,
		DeadlineAt:      deadline.UnixMilli(),
	}
	request.SafeSummary.ToolCallID = detail.ToolCallID
	request.SafeSummary.OptionCount = len(detail.Options)
	canonical, marshalErr := json.Marshal(request)
	if marshalErr != nil {
		slog.Info("acp_interaction.permission_cancelled", "reason", "request_invalid")
		return cancelledPermissionResponse(), nil
	}
	payloadHash := sha256.Sum256(canonical)
	request.PayloadHash = hex.EncodeToString(payloadHash[:])
	waiter, err := h.registerInteractionWaiter(interactionID, generation, optionIDs)
	if err != nil {
		slog.Info("acp_interaction.permission_cancelled", "reason", "generation_unavailable")
		return cancelledPermissionResponse(), nil
	}
	settle := func(reason string) {
		go h.settleAcpInteraction(acpInteractionSettleRequest{
			ProtocolVersion: acpInteractionProtocolVersion,
			InteractionID:   interactionID,
			Generation:      generation,
			RuntimeIdentity: h.config.RuntimeIdentity,
			AgentSessionID:  h.config.SessionID,
			Reason:          reason,
		}, deadline)
	}
	if err := h.createAcpInteraction(ctx, request); err != nil {
		h.cancelAcpInteractionWaiter(interactionID, generation, "wrapper_cancelled")
		settle("wrapper_cancelled")
		slog.Warn("acp_interaction.create_failed", "interactionId", interactionID,
			"reason", "control_plane_rejected")
		return cancelledPermissionResponse(), nil
	}

	timer := time.NewTimer(deadline.Sub(h.now()))
	defer timer.Stop()
	var result acpInteractionWaitResult
	select {
	case result = <-waiter.result:
	case <-ctx.Done():
		h.cancelAcpInteractionWaiter(interactionID, generation, "wrapper_cancelled")
		result = <-waiter.result
	case <-timer.C:
		h.cancelAcpInteractionWaiter(interactionID, generation, "expired")
		result = <-waiter.result
	}
	if result.cancel {
		reason := result.reason
		if reason == "" {
			reason = "wrapper_cancelled"
		}
		settle(reason)
		return cancelledPermissionResponse(), nil
	}
	settle("completed")
	return acpsdk.RequestPermissionResponse{
		Outcome: acpsdk.NewRequestPermissionOutcomeSelected(acpsdk.PermissionOptionId(result.optionID)),
	}, nil
}
