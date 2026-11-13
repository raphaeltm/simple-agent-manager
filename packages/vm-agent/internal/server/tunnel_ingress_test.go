package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
)

// These tests drive the Cloudflare Tunnel ingress through real TCP listeners
// started by serveListeners, the same code Server.Start runs. A request to the
// tunnel listener models what cloudflared delivers: a loopback peer with only
// the headers the remote caller chose. The relay harness supplies the real JWT
// validator, Git credential handler and a fake control plane that counts mints.

// freeLoopbackPort reserves and releases a loopback port for a listener the
// test starts by address. The tiny reuse race is acceptable in tests.
func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

type tunnelHarness struct {
	*relayHarness
	mainURL    string
	tunnelURL  string
	tunnelPort int
	served     chan error
}

// startTunnelHarness configures the relay harness server as a tunnel node and
// starts both listeners through serveListeners.
func startTunnelHarness(t *testing.T) *tunnelHarness {
	t.Helper()
	h := &tunnelHarness{relayHarness: newRelayHarness(t)}
	// The relay harness already serves the mux on agentPort for its own
	// helpers; give the production listeners fresh ports.
	h.server.config.Host = "127.0.0.1"
	h.server.config.Port = freeLoopbackPort(t)
	h.tunnelPort = freeLoopbackPort(t)
	h.server.config.Tunnel = config.TunnelConfig{Enabled: true, Port: h.tunnelPort}
	h.agentPort = h.server.config.Port

	mux := http.NewServeMux()
	h.server.setupRoutes(mux)
	h.server.buildHTTPServers(mux)

	h.served = make(chan error, 1)
	go func() { h.served <- h.server.serveListeners() }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = h.server.shutdownListeners(ctx)
	})

	h.mainURL = fmt.Sprintf("http://127.0.0.1:%d", h.server.config.Port)
	h.tunnelURL = fmt.Sprintf("http://127.0.0.1:%d", h.tunnelPort)
	waitForHealth(t, h.mainURL)
	waitForHealth(t, h.tunnelURL)
	return h
}

func waitForHealth(t *testing.T, baseURL string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		res, err := http.Get(baseURL + "/health")
		if err == nil {
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("listener %s never became healthy: %v", baseURL, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func get(t *testing.T, url string, headers map[string]string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return doRelayRequest(t, req)
}

// The incident: direct cloudflared ingress reaches loopback with no relay
// headers. On the tunnel listener the bearerless Git credential exchange must be
// refused whatever the caller sends, while the private Docker helper path on the
// main listener keeps working.
func TestTunnelListenerRefusesBearerlessGitCredential(t *testing.T) {
	h := startTunnelHarness(t)
	path := "/git-credential?host=github.com&workspaceId=" + relayTestWorkspaceID

	for _, tc := range []struct {
		name    string
		headers map[string]string
	}{
		{name: "no relay headers (observed cloudflared shape)"},
		{name: "caller names the relay headers as hop-by-hop", headers: map[string]string{
			"Connection": "keep-alive, " + proxiedRequestHeader + ", X-Forwarded-Host",
		}},
		{name: "caller sends an empty relay marker", headers: map[string]string{proxiedRequestHeader: ""}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, body := get(t, h.tunnelURL+path, tc.headers)
			if status != http.StatusUnauthorized {
				t.Fatalf("tunnel listener status = %d, want 401 (body %q)", status, body)
			}
			assertNoCredential(t, h.relayHarness, body)
		})
	}

	// Liveness and owner control: the same route on the main listener (the
	// Docker helper path) still answers a bearerless loopback call.
	status, body := get(t, h.mainURL+path, nil)
	if status != http.StatusOK || !strings.Contains(body, "password="+relayCanaryToken) {
		t.Fatalf("main listener helper exchange: status %d, want 200 with credential", status)
	}
}

// Existing bearer auth is unchanged through the tunnel: a caller holding the
// workspace callback token still gets a credential, a wrong bearer does not.
func TestTunnelListenerKeepsBearerCredentialAuth(t *testing.T) {
	h := startTunnelHarness(t)
	path := "/git-credential?host=github.com&workspaceId=" + relayTestWorkspaceID

	status, body := get(t, h.tunnelURL+path, map[string]string{"Authorization": "Bearer wrong-token"})
	if status != http.StatusUnauthorized {
		t.Fatalf("wrong bearer status = %d, want 401", status)
	}
	assertNoCredential(t, h.relayHarness, body)

	status, body = get(t, h.tunnelURL+path, map[string]string{"Authorization": "Bearer callback-token"})
	if status != http.StatusOK || !strings.Contains(body, "password="+relayCanaryToken) {
		t.Fatalf("callback bearer status = %d, want 200 with credential", status)
	}
}

// JWT-authorized port proxy traffic works through the tunnel and strips the
// token; a request without a token is rejected.
func TestTunnelListenerServesJWTAuthorizedPortProxy(t *testing.T) {
	h := startTunnelHarness(t)
	var gotToken, gotPath, gotMarker string
	devServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.URL.Query().Get("token")
		gotPath = r.URL.Path
		gotMarker = r.Header.Get(proxiedRequestHeader)
		_, _ = io.WriteString(w, "dev server ok")
	}))
	defer devServer.Close()
	devPort := devServer.Listener.Addr().(*net.TCPAddr).Port
	route := fmt.Sprintf("%s/workspaces/%s/ports/%d/app", h.tunnelURL, relayTestWorkspaceID, devPort)

	status, body := get(t, route+"?q=1&token="+h.portProxyToken(), nil)
	if status != http.StatusOK || body != "dev server ok" {
		t.Fatalf("authorized proxy status = %d body = %q, want 200 from dev server", status, body)
	}
	if gotPath != "/app" || gotToken != "" || gotMarker != "1" {
		t.Fatalf("dev server saw path=%q token=%q marker=%q", gotPath, gotToken, gotMarker)
	}

	status, _ = get(t, route, nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("tokenless proxy status = %d, want 401", status)
	}
}

// Port proxy and local forward must refuse both of the agent's own listeners,
// so neither public route can reach the agent's routes on loopback.
func TestTunnelNodeProxiesRefuseBothOwnListeners(t *testing.T) {
	h := startTunnelHarness(t)

	for _, port := range []int{h.server.config.Port, h.tunnelPort} {
		route := fmt.Sprintf("%s/workspaces/%s/ports/%d/git-credential?host=github.com&token=%s",
			h.tunnelURL, relayTestWorkspaceID, port, h.portProxyToken())
		status, body := get(t, route, nil)
		if status != http.StatusForbidden || !strings.Contains(body, "reserved for the SAM workspace agent") {
			t.Fatalf("port proxy to own port %d: status = %d body = %q, want 403", port, status, body)
		}
		assertNoCredential(t, h.relayHarness, body)
	}

	token := h.sign(auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{Subject: "user-1", Audience: jwt.ClaimStrings{"local-forward"}},
		Workspace:        relayTestWorkspaceID,
		Node:             "node-123",
		Type:             "local-forward",
		UserID:           "user-1",
		RemotePort:       h.tunnelPort,
		Mode:             "http",
		LocalAuthority:   "localhost:9999",
	})
	route := fmt.Sprintf("%s/workspaces/%s/local-forward/%d/git-credential?host=github.com", h.tunnelURL, relayTestWorkspaceID, h.tunnelPort)
	status, body := get(t, route, map[string]string{"X-SAM-VM-Forward-Token": token})
	if status != http.StatusForbidden {
		t.Fatalf("local forward to tunnel port: status = %d body = %q, want 403", status, body)
	}
	assertNoCredential(t, h.relayHarness, body)
}

// The tunnel listener is loopback-only even when the main listener binds every
// interface, so only the local connector can reach it.
func TestTunnelListenerBindsLoopbackOnly(t *testing.T) {
	cfg := &config.Config{Host: "0.0.0.0", Port: 8080, Tunnel: config.TunnelConfig{Enabled: true, Port: 8444}}
	s := &Server{config: cfg}
	s.buildHTTPServers(http.NewServeMux())
	if s.httpServer.Addr != "0.0.0.0:8080" {
		t.Fatalf("main addr = %q, want 0.0.0.0:8080", s.httpServer.Addr)
	}
	if s.tunnelServer == nil || s.tunnelServer.Addr != "127.0.0.1:8444" {
		t.Fatalf("tunnel server = %+v, want loopback 127.0.0.1:8444", s.tunnelServer)
	}

	h := startTunnelHarness(t)
	external := nonLoopbackIPv4(t)
	if external == "" {
		t.Skip("no non-loopback IPv4 interface to probe from")
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(external, fmt.Sprint(h.tunnelPort)), time.Second)
	if err == nil {
		_ = conn.Close()
		t.Fatalf("tunnel listener accepted a connection on %s", external)
	}
}

func nonLoopbackIPv4(t *testing.T) string {
	t.Helper()
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() && ipNet.IP.To4() != nil {
			return ipNet.IP.String()
		}
	}
	return ""
}

// Legacy direct-IP nodes and Instant containers get no tunnel listener, and the
// default tunnel port stays available to workspace apps.
func TestTunnelListenerDisabledByDefault(t *testing.T) {
	s := &Server{config: &config.Config{Host: "127.0.0.1", Port: freeLoopbackPort(t)}}
	s.buildHTTPServers(http.NewServeMux())
	if s.tunnelServer != nil {
		t.Fatalf("tunnel server built without VM_AGENT_TUNNEL_ENABLED: %+v", s.tunnelServer)
	}
	if s.isOwnListenerTarget("127.0.0.1", config.DefaultTunnelPort) {
		t.Fatal("a disabled tunnel port must not be reserved")
	}
	if !s.isOwnListenerTarget("127.0.0.1", s.config.Port) {
		t.Fatal("main listener port must stay reserved")
	}
}

func TestIsOwnListenerTargetCoversEnabledTunnelPort(t *testing.T) {
	s := &Server{config: &config.Config{Port: 8080, Tunnel: config.TunnelConfig{Enabled: true, Port: 8444}}}
	for _, tc := range []struct {
		host string
		port int
		want bool
	}{
		{"127.0.0.1", 8444, true},
		{"localhost", 8444, true},
		{"127.0.0.1", 8080, true},
		{"172.17.0.2", 8444, false},
		{"127.0.0.1", 3000, false},
	} {
		if got := s.isOwnListenerTarget(tc.host, tc.port); got != tc.want {
			t.Errorf("isOwnListenerTarget(%q, %d) = %v, want %v", tc.host, tc.port, got, tc.want)
		}
	}
}

// Stop shuts down both listeners and serveListeners reports a clean close.
func TestServeListenersStopClosesBothListeners(t *testing.T) {
	s := newShutdownTestServer(t)
	s.config = &config.Config{
		Host:   "127.0.0.1",
		Port:   freeLoopbackPort(t),
		Tunnel: config.TunnelConfig{Enabled: true, Port: freeLoopbackPort(t)},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	s.buildHTTPServers(mux)
	mainURL := fmt.Sprintf("http://127.0.0.1:%d", s.config.Port)
	tunnelURL := fmt.Sprintf("http://127.0.0.1:%d", s.config.Tunnel.Port)

	served := make(chan error, 1)
	go func() { served <- s.serveListeners() }()
	waitForHealth(t, mainURL)
	waitForHealth(t, tunnelURL)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Stop(ctx); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	select {
	case err := <-served:
		if !errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("serveListeners returned %v, want http.ErrServerClosed", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serveListeners did not return after Stop")
	}
	for _, addr := range []string{s.httpServer.Addr, s.tunnelServer.Addr} {
		if conn, err := net.DialTimeout("tcp", addr, time.Second); err == nil {
			_ = conn.Close()
			t.Fatalf("%s still accepts connections after Stop", addr)
		}
	}
}

// A tunnel bind failure fails startup and does not leave the main listener up:
// a node serving only half its ingress would look alive but be unreachable.
func TestServeListenersTunnelBindFailureFailsStartup(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("occupy port: %v", err)
	}
	defer occupied.Close()
	tunnelPort := occupied.Addr().(*net.TCPAddr).Port

	s := &Server{config: &config.Config{
		Host:   "127.0.0.1",
		Port:   freeLoopbackPort(t),
		Tunnel: config.TunnelConfig{Enabled: true, Port: tunnelPort},
	}}
	s.buildHTTPServers(http.NewServeMux())

	err = s.serveListeners()
	if err == nil || !strings.Contains(err.Error(), "tunnel") {
		t.Fatalf("serveListeners error = %v, want tunnel bind failure", err)
	}
	if conn, dialErr := net.DialTimeout("tcp", s.httpServer.Addr, time.Second); dialErr == nil {
		_ = conn.Close()
		t.Fatalf("main listener %s left open after tunnel bind failure", s.httpServer.Addr)
	}
}

// A slow request draining on the tunnel listener must not keep the main
// listener accepting: both listeners stop accepting as soon as Stop starts.
func TestStopClosesMainListenerWhileTunnelRequestDrains(t *testing.T) {
	s := newShutdownTestServer(t)
	s.config = &config.Config{
		Host:   "127.0.0.1",
		Port:   freeLoopbackPort(t),
		Tunnel: config.TunnelConfig{Enabled: true, Port: freeLoopbackPort(t)},
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /slow", func(w http.ResponseWriter, _ *http.Request) {
		close(entered)
		<-release
	})
	s.buildHTTPServers(mux)
	go func() { _ = s.serveListeners() }()
	tunnelURL := fmt.Sprintf("http://127.0.0.1:%d", s.config.Tunnel.Port)
	waitForHealth(t, fmt.Sprintf("http://127.0.0.1:%d", s.config.Port))
	waitForHealth(t, tunnelURL)

	go func() {
		if res, err := http.Get(tunnelURL + "/slow"); err == nil {
			_ = res.Body.Close()
		}
	}()
	<-entered

	stopped := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		stopped <- s.Stop(ctx)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", s.httpServer.Addr, 100*time.Millisecond)
		if err != nil {
			break
		}
		_ = conn.Close()
		if time.Now().After(deadline) {
			close(release)
			t.Fatal("main listener still accepting while the tunnel request drains")
		}
		time.Sleep(10 * time.Millisecond)
	}

	close(release)
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatalf("Stop: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not return after the tunnel request finished")
	}
}
