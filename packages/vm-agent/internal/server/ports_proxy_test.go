package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func TestPortProxyForwardsHostHeader(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name            string
		forwardedHost   string // X-Forwarded-Host header value (empty = absent)
		controlPlaneURL string
		workspaceID     string
		port            int
		wantHost        string
	}{
		{
			name:            "uses X-Forwarded-Host when it matches expected pattern",
			forwardedHost:   "ws-abc123--5173.simple-agent-manager.org",
			controlPlaneURL: "https://api.simple-agent-manager.org",
			workspaceID:     "ABC123",
			port:            5173,
			wantHost:        "ws-abc123--5173.simple-agent-manager.org",
		},
		{
			name:            "falls back to derived host when X-Forwarded-Host absent",
			forwardedHost:   "",
			controlPlaneURL: "https://api.example.com",
			workspaceID:     "WS001",
			port:            3000,
			wantHost:        "ws-ws001--3000.example.com",
		},
		{
			name:            "rejects spoofed X-Forwarded-Host that does not match expected pattern",
			forwardedHost:   "evil.attacker.com",
			controlPlaneURL: "https://api.example.com",
			workspaceID:     "WS001",
			port:            3000,
			wantHost:        "ws-ws001--3000.example.com",
		},
		{
			name:            "rejects X-Forwarded-Host with wrong domain",
			forwardedHost:   "ws-ws001--3000.wrong-domain.com",
			controlPlaneURL: "https://api.example.com",
			workspaceID:     "WS001",
			port:            3000,
			wantHost:        "ws-ws001--3000.example.com",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			// Create a backend server that captures the Host header it receives.
			var gotHost string
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotHost = r.Host
				w.WriteHeader(http.StatusOK)
				io.WriteString(w, "ok")
			}))
			defer backend.Close()

			// Build a minimal Server with the test config.
			s := &Server{
				config: &config.Config{
					ControlPlaneURL: tc.controlPlaneURL,
				},
			}

			// Call the helper that builds the port proxy and serves the request.
			// We bypass auth and bridge IP resolution by calling the proxy builder directly.
			rr := httptest.NewRecorder()
			req := httptest.NewRequest("GET", backend.URL+"/test-path", nil)
			if tc.forwardedHost != "" {
				req.Header.Set("X-Forwarded-Host", tc.forwardedHost)
			}

			s.servePortProxy(rr, req, tc.workspaceID, tc.port, backend.URL, "/test-path")

			if rr.Code != http.StatusOK {
				t.Fatalf("unexpected status code: got %d, want 200. Body: %s", rr.Code, rr.Body.String())
			}
			if gotHost != tc.wantHost {
				t.Fatalf("Host header mismatch: got %q, want %q", gotHost, tc.wantHost)
			}
		})
	}
}
