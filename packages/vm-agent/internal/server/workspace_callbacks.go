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

	"github.com/workspace/vm-agent/internal/callbackretry"
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

	return callbackretry.Do(ctx, callbackretry.DefaultConfig(), "provisioning-failed", func(retryCtx context.Context) error {
		requestCtx := retryCtx
		cancel := func() {}
		if s.config.HTTPReadTimeout > 0 {
			requestCtx, cancel = context.WithTimeout(retryCtx, s.config.HTTPReadTimeout)
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
			err := fmt.Errorf(
				"provisioning-failed callback returned HTTP %d: %s",
				resp.StatusCode,
				strings.TrimSpace(string(responseBody)),
			)
			// Most 4xx errors are permanent — retrying won't help.
			// Exceptions: 408 (Request Timeout) and 429 (Too Many Requests) are transient.
			if resp.StatusCode >= 400 && resp.StatusCode < 500 &&
				resp.StatusCode != http.StatusRequestTimeout &&
				resp.StatusCode != http.StatusTooManyRequests {
				return callbackretry.Permanent(err)
			}
			return err
		}

		return nil
	})
}
