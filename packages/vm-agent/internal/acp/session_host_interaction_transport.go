package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type acpInteractionCreateOutcome string

const (
	acpInteractionCreateAcknowledged acpInteractionCreateOutcome = "acknowledged"
	acpInteractionCreateRejected     acpInteractionCreateOutcome = "rejected"
	acpInteractionCreateUnknown      acpInteractionCreateOutcome = "unknown"
)

func (h *SessionHost) createAcpInteraction(ctx context.Context, request acpInteractionCreateRequest) (acpInteractionCreateOutcome, error) {
	config := h.acpInteractionConfigSnapshot()
	body, err := json.Marshal(request)
	if err != nil {
		return acpInteractionCreateRejected, fmt.Errorf("marshal ACP interaction create: %w", err)
	}
	endpoint := strings.TrimRight(h.config.ControlPlaneURL, "/") + "/api/projects/" +
		url.PathEscape(h.config.ProjectID) + "/workspaces/" + url.PathEscape(h.config.WorkspaceID) +
		"/acp-interactions"
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return acpInteractionCreateRejected, fmt.Errorf("build ACP interaction create: %w", err)
	}
	httpRequest.Header.Set("Authorization", "Bearer "+h.config.CallbackToken)
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := h.httpClient().Do(httpRequest)
	if err != nil {
		return acpInteractionCreateUnknown, fmt.Errorf("send ACP interaction create: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, config.ResponseMaxBytes))
		return acpInteractionCreateRejected, fmt.Errorf("ACP interaction create rejected with status %d", response.StatusCode)
	}
	var result struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, config.ResponseMaxBytes)).Decode(&result); err != nil {
		return acpInteractionCreateUnknown, fmt.Errorf("decode ACP interaction create response: %w", err)
	}
	if result.Status != "created" && result.Status != "existing" {
		return acpInteractionCreateUnknown, fmt.Errorf("ACP interaction create returned unknown status %q", result.Status)
	}
	return acpInteractionCreateAcknowledged, nil
}

func (h *SessionHost) settleAcpInteraction(request acpInteractionSettleRequest, deadline time.Time) {
	config := h.acpInteractionConfigSnapshot()
	if !config.Enabled || h.config.CallbackToken == "" || h.config.ControlPlaneURL == "" {
		return
	}
	maxDuration := time.Duration(config.MaxDeadlineMs) * time.Millisecond
	remaining := deadline.Sub(h.now())
	minimum := time.Duration(config.DeadlineMarginMs) * time.Millisecond
	if remaining < minimum {
		remaining = minimum
	}
	if remaining > maxDuration {
		remaining = maxDuration
	}
	ctx, cancel := context.WithTimeout(context.Background(), remaining)
	defer cancel()
	body, err := json.Marshal(request)
	if err != nil {
		return
	}
	endpoint := strings.TrimRight(h.config.ControlPlaneURL, "/") + "/api/projects/" +
		url.PathEscape(h.config.ProjectID) + "/workspaces/" + url.PathEscape(h.config.WorkspaceID) +
		"/acp-interactions/" + url.PathEscape(request.InteractionID) + "/settle"
	delays := append([]int{0}, config.SettleRetryDelaysMs...)
	for attempt := 0; ; attempt++ {
		if attempt > 0 {
			delay := config.SettleRetrySteadyMs
			if attempt-1 < len(delays)-1 {
				delay = delays[attempt]
			}
			timer := time.NewTimer(time.Duration(delay) * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
		httpRequest, buildErr := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if buildErr != nil {
			return
		}
		httpRequest.Header.Set("Authorization", "Bearer "+h.config.CallbackToken)
		httpRequest.Header.Set("Content-Type", "application/json")
		response, sendErr := h.httpClient().Do(httpRequest)
		if sendErr == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, config.ResponseMaxBytes))
			response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				return
			}
			if response.StatusCode == http.StatusBadRequest || response.StatusCode == http.StatusUnauthorized ||
				response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusNotFound ||
				response.StatusCode == http.StatusConflict || response.StatusCode == http.StatusGone {
				return
			}
		}
		slog.Warn("acp_interaction.settle_retry", "interactionId", request.InteractionID,
			"attempt", attempt+1, "reason", request.Reason)
	}
}
