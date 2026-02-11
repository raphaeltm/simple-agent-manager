package idle

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// ShutdownConfig holds configuration for the request-shutdown call.
type ShutdownConfig struct {
	ControlPlaneURL string
	WorkspaceID     string
	CallbackToken   string
	MaxAttempts     int           // Number of retry attempts (default 3)
	RetryDelay      time.Duration // Delay between retries (default 5s)
	HTTPTimeout     time.Duration // HTTP client timeout (default 15s)
}

// RequestShutdown calls the control plane's /request-shutdown endpoint with retries.
// Returns nil on success (2xx response), or the last error after all retries fail.
func RequestShutdown(cfg ShutdownConfig) error {
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 3
	}
	if cfg.RetryDelay <= 0 {
		cfg.RetryDelay = 5 * time.Second
	}
	if cfg.HTTPTimeout <= 0 {
		cfg.HTTPTimeout = 15 * time.Second
	}

	payload, err := json.Marshal(map[string]string{"reason": "idle_timeout"})
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	url := cfg.ControlPlaneURL + "/api/workspaces/" + cfg.WorkspaceID + "/request-shutdown"
	client := &http.Client{Timeout: cfg.HTTPTimeout}

	var lastErr error
	for attempt := 1; attempt <= cfg.MaxAttempts; attempt++ {
		if attempt > 1 {
			log.Printf("Retry %d/%d after %v...", attempt, cfg.MaxAttempts, cfg.RetryDelay)
			time.Sleep(cfg.RetryDelay)
		}

		req, err := http.NewRequest("POST", url, bytes.NewBuffer(payload))
		if err != nil {
			lastErr = fmt.Errorf("create request: %w", err)
			log.Printf("Attempt %d: %v", attempt, lastErr)
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+cfg.CallbackToken)

		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("send request: %w", err)
			log.Printf("Attempt %d: %v", attempt, lastErr)
			continue
		}

		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusAccepted {
			log.Printf("Successfully requested VM deletion (status %d, body: %s)", resp.StatusCode, string(body))
			return nil
		}

		lastErr = fmt.Errorf("status %d, body: %s", resp.StatusCode, string(body))
		log.Printf("Attempt %d: shutdown request failed: %v", attempt, lastErr)
	}

	return fmt.Errorf("all %d attempts failed, last error: %w", cfg.MaxAttempts, lastErr)
}
