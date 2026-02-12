package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"strings"
)

func (s *Server) notifyWorkspaceProvisioningFailed(
	ctx context.Context,
	workspaceID string,
	callbackToken string,
	errorMessage string,
) error {
	trimmedWorkspaceID := strings.TrimSpace(workspaceID)
	if trimmedWorkspaceID == "" {
		return fmt.Errorf("workspace id is required")
	}

	trimmedCallbackToken := strings.TrimSpace(callbackToken)
	if trimmedCallbackToken == "" {
		return fmt.Errorf("callback token is required")
	}

	payload := map[string]string{
		"errorMessage": strings.TrimSpace(errorMessage),
	}
	if payload["errorMessage"] == "" {
		payload["errorMessage"] = "workspace provisioning failed"
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal provisioning-failed payload: %w", err)
	}

	endpoint := fmt.Sprintf(
		"%s/api/workspaces/%s/provisioning-failed",
		strings.TrimRight(s.config.ControlPlaneURL, "/"),
		neturl.PathEscape(trimmedWorkspaceID),
	)

	requestCtx := ctx
	cancel := func() {}
	if s.config.HTTPReadTimeout > 0 {
		requestCtx, cancel = context.WithTimeout(ctx, s.config.HTTPReadTimeout)
	}
	defer cancel()

	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build provisioning-failed request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+trimmedCallbackToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("send provisioning-failed request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
		return fmt.Errorf(
			"provisioning-failed callback returned HTTP %d: %s",
			resp.StatusCode,
			strings.TrimSpace(string(responseBody)),
		)
	}

	return nil
}
