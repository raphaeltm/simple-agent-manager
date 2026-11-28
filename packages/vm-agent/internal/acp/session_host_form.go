package acp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"
)

func cancelledFormResponse() acpsdk.CreateElicitationResponse {
	return acpsdk.CreateElicitationResponse{Cancel: &acpsdk.CreateElicitationCancel{Action: "cancel"}}
}

func supportedFormRequestMeta(meta acpsdk.Meta) bool {
	if len(meta) == 0 {
		return true
	}
	if len(meta) != 1 {
		return false
	}
	var codex map[string]any
	err := meta.Get("codex", &codex)
	ok := err == nil && codex != nil
	if !ok || !formOnlyKeys(codex, "autoResolutionMs") {
		return false
	}
	if !hasFormKey(codex, "autoResolutionMs") || codex["autoResolutionMs"] == nil {
		return true
	}
	value, ok := codex["autoResolutionMs"].(float64)
	return ok && value >= 0 && value <= 9007199254740991 && math.Trunc(value) == value
}

func (h *SessionHost) registerFormWaiter(id, generation string, attemptID uint64,
	schema map[string]any, limits acpFormLimits, cancel context.CancelFunc) (*acpInteractionWaiter, error) {
	h.promptMu.Lock()
	defer h.promptMu.Unlock()
	h.interactionMu.Lock()
	defer h.interactionMu.Unlock()
	if !h.interactionConfig.Enabled || !h.interactionConfig.FormsEnabled ||
		generation == "" || generation != h.interactionGeneration ||
		!h.promptInFlight || h.promptAttempt == nil || h.promptAttempt.id != attemptID ||
		h.promptAttempt.ctx.Err() != nil {
		return nil, errors.New("form generation unavailable")
	}
	if _, exists := h.interactionWaiters[id]; exists {
		return nil, errors.New("form waiter already exists")
	}
	waiter := &acpInteractionWaiter{generation: generation, attemptID: attemptID,
		formSchema: schema, formLimits: limits, result: make(chan acpInteractionWaitResult, 1), cancelRequest: cancel}
	h.interactionWaiters[id] = waiter
	return waiter, nil
}

func (h *SessionHost) requestForm(ctx context.Context, generation string,
	params acpsdk.CreateElicitationRequest) (acpsdk.CreateElicitationResponse, error) {
	config := h.acpInteractionConfigSnapshot()
	if params.Form == nil || params.Url != nil || !supportedFormRequestMeta(params.Form.Meta) ||
		!config.Enabled || !config.FormsEnabled ||
		config.validate() != nil || generation == "" || h.config.ProjectID == "" ||
		h.config.WorkspaceID == "" || h.config.SessionID == "" || h.config.RuntimeIdentity == "" ||
		h.callbackToken() == "" || h.config.ControlPlaneURL == "" {
		slog.Info("acp_interaction.form_cancelled", "reason", "unsupported")
		return cancelledFormResponse(), nil
	}
	attempt, ok := h.activePromptAttempt()
	if !ok {
		return cancelledFormResponse(), nil
	}
	formConfig := config
	formConfig.PermissionDeadlineMs = config.FormDeadlineMs
	deadline, ok := h.permissionDeadline(attempt.ctx, formConfig)
	if !ok {
		return cancelledFormResponse(), nil
	}
	var codex map[string]any
	if params.Form.Meta.Get("codex", &codex) == nil && codex != nil {
		if value, isNumber := codex["autoResolutionMs"].(float64); isNumber && value < float64(config.FormDeadlineMs) {
			if value <= 0 {
				return cancelledFormResponse(), nil
			}
			wrapperDeadline := time.Now().Add(time.Duration(value) * time.Millisecond)
			if wrapperDeadline.Before(deadline) {
				deadline = wrapperDeadline
			}
		}
	}
	schemaJSON, err := json.Marshal(params.Form.RequestedSchema)
	if err != nil || len(schemaJSON) > config.FormSchemaMaxBytes {
		return cancelledFormResponse(), nil
	}
	var schema map[string]any
	if json.Unmarshal(schemaJSON, &schema) != nil || !validateAcpFormSchema(schema, formLimits(config)) ||
		len(params.Form.Message) > config.RequestMaxBytes {
		return cancelledFormResponse(), nil
	}
	detail := acpInteractionDetail{Message: &params.Form.Message, Schema: schema}
	encoded, err := json.Marshal(detail)
	if err != nil || len(encoded) > config.RequestMaxBytes {
		return cancelledFormResponse(), nil
	}
	id := uuid.NewString()
	request := acpInteractionCreateRequest{ProtocolVersion: acpInteractionProtocolVersion,
		InteractionID: id, Generation: generation, RuntimeIdentity: h.config.RuntimeIdentity,
		AgentSessionID: h.config.SessionID, Kind: "form", Detail: detail, DeadlineAt: deadline.UnixMilli()}
	canonical, err := json.Marshal(request)
	if err != nil {
		return cancelledFormResponse(), nil
	}
	digest := sha256.Sum256(canonical)
	request.PayloadHash = hex.EncodeToString(digest[:])
	requestCtx, cancel := context.WithDeadline(attempt.ctx, deadline)
	go func() {
		select {
		case <-attempt.done:
			cancel()
		case <-requestCtx.Done():
		}
	}()
	stopCancel := context.AfterFunc(ctx, cancel)
	defer stopCancel()
	defer cancel()
	waiter, err := h.registerFormWaiter(id, generation, attempt.id, schema, formLimits(config), cancel)
	if err != nil {
		return cancelledFormResponse(), nil
	}
	createDone := make(chan acpInteractionCreateResult, 1)
	go func() {
		outcome, err := h.createAcpInteraction(requestCtx, request)
		createDone <- acpInteractionCreateResult{outcome: outcome, err: err}
	}()
	settle := func(reason string) {
		go h.settleAcpInteraction(acpInteractionSettleRequest{ProtocolVersion: acpInteractionProtocolVersion,
			InteractionID: id, Generation: generation, RuntimeIdentity: h.config.RuntimeIdentity,
			AgentSessionID: h.config.SessionID, Reason: reason}, deadline)
	}
	var result acpInteractionWaitResult
	select {
	case result = <-waiter.result:
	case created := <-createDone:
		if created.outcome == acpInteractionCreateRejected {
			h.cancelAcpInteractionWaiter(id, generation, "wrapper_cancelled")
		}
		select {
		case result = <-waiter.result:
		case <-requestCtx.Done():
			reason := "wrapper_cancelled"
			if errors.Is(requestCtx.Err(), context.DeadlineExceeded) {
				reason = "expired"
			}
			h.cancelAcpInteractionWaiterForAttempt(id, generation, attempt.id, reason)
			result = <-waiter.result
		}
	case <-requestCtx.Done():
		reason := "wrapper_cancelled"
		if errors.Is(requestCtx.Err(), context.DeadlineExceeded) {
			reason = "expired"
		}
		h.cancelAcpInteractionWaiterForAttempt(id, generation, attempt.id, reason)
		result = <-waiter.result
	}
	if result.cancel {
		reason := result.reason
		if reason == "" {
			reason = "wrapper_cancelled"
		}
		if reason == "declined" {
			settle("completed")
			return acpsdk.CreateElicitationResponse{Decline: &acpsdk.CreateElicitationDecline{Action: "decline"}}, nil
		}
		settle(reason)
		return cancelledFormResponse(), nil
	}
	// Content has already passed SAM's schema/primitive validation. Use the
	// SDK's typed decoder too, so invalid values cancel rather than escape.
	encodedContent, err := json.Marshal(result.content)
	var content map[string]acpsdk.ElicitationContentValue
	if err != nil || json.Unmarshal(encodedContent, &content) != nil {
		settle("wrapper_cancelled")
		return cancelledFormResponse(), nil
	}
	settle("completed")
	return acpsdk.CreateElicitationResponse{Accept: &acpsdk.CreateElicitationAccept{
		Action: "accept", Content: content}}, nil
}

func (c *sessionHostClient) CreateElicitation(ctx context.Context,
	params acpsdk.CreateElicitationRequest) (acpsdk.CreateElicitationResponse, error) {
	if params.Url != nil {
		return c.host.requestURL(ctx, c.interactionGeneration, params)
	}
	return c.host.requestForm(ctx, c.interactionGeneration, params)
}
