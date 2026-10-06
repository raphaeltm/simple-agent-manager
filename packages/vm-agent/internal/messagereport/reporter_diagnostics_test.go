package messagereport

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func TestDoPostReturnsBoundedResponseBody(t *testing.T) {
	t.Parallel()

	cfg := DefaultConfig()
	cfg.ResponseMaxBytes = 64
	longBody := strings.Repeat("x", cfg.ResponseMaxBytes+128)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(longBody))
	}))
	t.Cleanup(server.Close)

	reporter := &Reporter{client: config.NewControlPlaneClient(0), cfg: cfg}
	status, responseBody, err := reporter.doPost(server.URL, "token", []byte(`{"messages":[]}`))
	if err != nil {
		t.Fatalf("doPost returned error: %v", err)
	}
	if status != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", status)
	}
	if len(responseBody) != cfg.ResponseMaxBytes {
		t.Fatalf("response body length = %d, want %d", len(responseBody), cfg.ResponseMaxBytes)
	}
}
