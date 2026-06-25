package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
)

type releaseEvent struct {
	EnvironmentID  string         `json:"environmentId"`
	ReleaseVersion int64          `json:"releaseVersion,omitempty"`
	Level          string         `json:"level,omitempty"`
	EventType      string         `json:"eventType"`
	Step           string         `json:"step,omitempty"`
	Message        string         `json:"message"`
	Detail         map[string]any `json:"detail,omitempty"`
}

func (e *Engine) reportApplyEvent(ctx context.Context, payload *ApplyPayload, level, eventType, step, message string, detail map[string]any) {
	if e == nil || payload == nil {
		return
	}
	if level == "" {
		level = "info"
	}
	ev := releaseEvent{
		EnvironmentID:  payload.EnvironmentID,
		ReleaseVersion: payload.Seq,
		Level:          level,
		EventType:      eventType,
		Step:           step,
		Message:        message,
		Detail:         detail,
	}
	if e.cfg.ApplyProgress != nil {
		e.cfg.ApplyProgress(ctx, ApplyProgressEvent{
			EnvironmentID: payload.EnvironmentID,
			NodeID:        payload.NodeID,
			Seq:           payload.Seq,
			Level:         level,
			EventType:     eventType,
			Step:          step,
			Message:       message,
			Detail:        detail,
		})
	}
	if strings.TrimSpace(e.cfg.ControlPlaneURL) == "" || strings.TrimSpace(e.getCallbackToken()) == "" {
		return
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		slog.Warn("deploy.apply_event: marshal failed", "eventType", eventType, "error", err)
		return
	}
	url := strings.TrimRight(e.cfg.ControlPlaneURL, "/") + "/api/nodes/" + e.cfg.NodeID + "/deployment-release-events"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		slog.Warn("deploy.apply_event: request creation failed", "eventType", eventType, "error", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+e.getCallbackToken())
	req.Header.Set("Content-Type", "application/json")
	resp, err := e.cfg.HTTPClient.Do(req)
	if err != nil {
		slog.Warn("deploy.apply_event: send failed", "eventType", eventType, "error", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		slog.Warn("deploy.apply_event: rejected", "eventType", eventType, "status", resp.StatusCode, "body", string(body))
	}
}
