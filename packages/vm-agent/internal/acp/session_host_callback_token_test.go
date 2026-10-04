package acp

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// activityAuthorizations records the bearer token of every activity report.
func activityAuthorizations(t *testing.T) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var tokens []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/activity") {
			mu.Lock()
			tokens = append(tokens, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
			mu.Unlock()
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)
	return server, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), tokens...)
	}
}

func TestSessionHostControlPlaneCallsUseRenewedCallbackToken(t *testing.T) {
	server, seen := activityAuthorizations(t)
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		ProjectID: "project", NodeID: "node", SessionID: "session",
		ControlPlaneURL: server.URL, CallbackToken: "created-with", HTTPClient: server.Client(),
	}})
	defer host.Stop()

	host.reportActivity("idle")
	waitFor(t, time.Second, func() bool { return len(seen()) == 1 })

	host.SetCallbackToken("renewed")
	host.reportActivity("idle")
	waitFor(t, time.Second, func() bool { return len(seen()) == 2 })

	if got := strings.Join(seen(), ","); got != "created-with,renewed" {
		t.Fatalf("activity reports authenticated with %q, want created-with then renewed", got)
	}
	if !host.UsesCallbackToken("renewed") || host.UsesCallbackToken("created-with") {
		t.Fatal("UsesCallbackToken disagrees with the token the host sends")
	}
}

func TestSessionHostIgnoresEmptyCallbackToken(t *testing.T) {
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{CallbackToken: "created-with"}})
	defer host.Stop()

	host.SetCallbackToken("   ")
	if !host.UsesCallbackToken("created-with") {
		t.Fatal("an empty delivery must not clear the host's callback token")
	}
	if host.UsesCallbackToken("") {
		t.Fatal("UsesCallbackToken must never match an empty token")
	}
}

// Renewals arrive on the heartbeat goroutine while control-plane calls read the
// token on others, including the ACP notification goroutine (rule 46). Run under
// -race: the accessor must be safe without h.mu.
func TestSessionHostCallbackTokenIsRaceFreeAcrossGoroutines(t *testing.T) {
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{CallbackToken: "t0"}})
	defer host.Stop()

	var wg sync.WaitGroup
	stop := make(chan struct{})
	reads := 0
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				if token := host.callbackToken(); token == "" {
					t.Error("reader observed an empty callback token")
					return
				}
				reads++
			}
		}
	}()
	for i := 0; i < 2000; i++ {
		host.SetCallbackToken("t" + strings.Repeat("x", i%7+1))
	}
	close(stop)
	wg.Wait()
	if reads == 0 {
		t.Fatal("reader goroutine never ran; the race check proved nothing")
	}
}
