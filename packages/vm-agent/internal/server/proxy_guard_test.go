package server

import (
	"crypto/rsa"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
)

// These tests drive the standalone (Instant / cf-container) relay path through
// real listeners: the request shape the API Worker sends for a public
// ws-<id>--<port> route reaches the vm-agent mux over TCP, the real port proxy
// relays it to 127.0.0.1:<port>, and whatever answers there sees the proxy as
// its loopback peer. The control plane is a fake that counts token mints.

const relayTestWorkspaceID = "01KR1000000000000000000001"
const relayTestBaseDomain = "workspaces.example.com"
const relayCanaryToken = "ghs_relay_canary_must_not_leak"

type relayHarness struct {
	t          *testing.T
	server     *Server
	agentURL   string
	agentPort  int
	key        *rsa.PrivateKey
	tokenMints atomic.Int32
}

func newRelayHarness(t *testing.T) *relayHarness {
	t.Helper()
	h := &relayHarness{t: t}

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/git-token") {
			h.tokenMints.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"token":%q,"expiresAt":"2030-01-01T00:00:00Z"}`, relayCanaryToken)
	}))
	t.Cleanup(controlPlane.Close)

	validator, key := testGitCredentialJWTValidator(t)
	h.key = key

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	h.agentPort = listener.Addr().(*net.TCPAddr).Port
	h.agentURL = "http://" + listener.Addr().String()

	h.server = &Server{
		config: &config.Config{
			Role:            config.RoleStandalone,
			Port:            h.agentPort,
			ControlPlaneURL: controlPlane.URL,
			WorkspaceID:     relayTestWorkspaceID,
			CallbackToken:   "callback-token",
			NodeID:          "node-123",
		},
		jwtValidator:   validator,
		sessionManager: auth.NewSessionManager("session", false, time.Hour),
		workspaces:     make(map[string]*WorkspaceRuntime),
	}
	h.serveAgentMux(listener)
	return h
}

// serveAgentMux serves this harness's vm-agent routes on a listener.
func (h *relayHarness) serveAgentMux(listener net.Listener) {
	mux := http.NewServeMux()
	h.server.setupRoutes(mux)
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(listener) }()
	h.t.Cleanup(func() { _ = srv.Close() })
}

func (h *relayHarness) sign(claims auth.Claims) string {
	h.t.Helper()
	claims.Issuer = "test-issuer"
	claims.IssuedAt = jwt.NewNumericDate(time.Now())
	claims.ExpiresAt = jwt.NewNumericDate(time.Now().Add(5 * time.Minute))
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = "test-key-1"
	signed, err := token.SignedString(h.key)
	if err != nil {
		h.t.Fatalf("sign token: %v", err)
	}
	return signed
}

// portProxyToken mirrors signTerminalToken('port-proxy', workspaceId) in the API.
func (h *relayHarness) portProxyToken() string {
	return h.sign(auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:  "port-proxy",
			Audience: jwt.ClaimStrings{"workspace-terminal"},
		},
		Workspace: relayTestWorkspaceID,
	})
}

// apiPortRequest builds the request the API Worker's cf-container branch sends
// for ws-<id>--<targetPort>.<domain><subPath>?<query> (apps/api/src/index.ts).
// withWorkerHeaders=false drops the Worker-added forwarding headers so a test can
// observe the vm-agent proxy's own relay marker in isolation.
func (h *relayHarness) apiPortRequest(targetPort int, subPath, query string, withWorkerHeaders bool) *http.Request {
	h.t.Helper()
	q, err := url.ParseQuery(query)
	if err != nil {
		h.t.Fatalf("parse query: %v", err)
	}
	q.Set("token", h.portProxyToken())
	target := fmt.Sprintf("%s/workspaces/%s/ports/%d%s?%s", h.agentURL, relayTestWorkspaceID, targetPort, subPath, q.Encode())
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		h.t.Fatalf("build request: %v", err)
	}
	req.Header.Set("X-SAM-Node-Id", "node-123")
	req.Header.Set("X-SAM-Workspace-Id", relayTestWorkspaceID)
	if withWorkerHeaders {
		req.Header.Set("X-Forwarded-Host", fmt.Sprintf("ws-%s--%d.%s", strings.ToLower(relayTestWorkspaceID), targetPort, relayTestBaseDomain))
		req.Header.Set("X-Forwarded-Proto", "https")
		req.Header.Set(proxiedRequestHeader, "1")
	}
	return req
}

func doRelayRequest(t *testing.T, req *http.Request) (int, string) {
	t.Helper()
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(body)
}

func assertNoCredential(t *testing.T, h *relayHarness, body string) {
	t.Helper()
	if strings.Contains(body, "password=") || strings.Contains(body, relayCanaryToken) {
		t.Fatal("relayed request received a git credential")
	}
	if n := h.tokenMints.Load(); n != 0 {
		t.Fatalf("relayed request minted %d git tokens, want 0", n)
	}
}

// Public port route to the vm-agent's own port: the port proxy must refuse
// before anything reaches the agent's routes.
func TestPortProxyRefusesVMAgentOwnListenerOnPublicPortRoute(t *testing.T) {
	h := newRelayHarness(t)

	status, body := doRelayRequest(t, h.apiPortRequest(h.agentPort, "/git-credential", "host=github.com", true))

	if status != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %q)", status, body)
	}
	if !strings.Contains(body, "reserved for the SAM workspace agent") {
		t.Fatalf("expected reserved-port message, got %q", body)
	}
	assertNoCredential(t, h, body)
}

// The agent's routes reached through the port proxy on a port the own-listener
// guard does not cover (here a second listener serving the same mux). The relay
// marker the proxy adds must deny bearerless peer-address trust on its own,
// without the Worker's forwarding headers.
func TestPortProxyRelayToAgentRoutesGetsNoLoopbackCredentialTrust(t *testing.T) {
	h := newRelayHarness(t)
	second, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	h.serveAgentMux(second)
	secondPort := second.Addr().(*net.TCPAddr).Port

	for _, connection := range []string{"", "keep-alive, " + proxiedRequestHeader + ", X-Forwarded-Host"} {
		// A client may name headers in Connection to have the proxy strip them
		// as hop-by-hop after its Director runs; the marker must survive that.
		req := h.apiPortRequest(secondPort, "/git-credential", "host=github.com", false)
		if connection != "" {
			req.Header.Set("Connection", connection)
		}
		status, body := doRelayRequest(t, req)

		if status != http.StatusUnauthorized {
			t.Fatalf("Connection %q: status = %d, want 401 (body %q)", connection, status, body)
		}
		assertNoCredential(t, h, body)
	}

	// Liveness: the same second listener answers a direct loopback helper call,
	// so the 401 above is the relay check and not a broken listener.
	direct, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/git-credential?host=github.com&workspaceId=%s", secondPort, relayTestWorkspaceID))
	if err != nil {
		t.Fatalf("direct request: %v", err)
	}
	defer direct.Body.Close()
	directBody, _ := io.ReadAll(direct.Body)
	if direct.StatusCode != http.StatusOK || !strings.Contains(string(directBody), "password="+relayCanaryToken) {
		t.Fatalf("direct loopback helper exchange: status %d, want 200 with credential", direct.StatusCode)
	}
}

// Owner control: with the same public-port request shape, a dev server port is
// still proxied, the port-proxy token is stripped, and the relay is marked.
func TestPortProxyStillProxiesDevServerPortOnPublicPortRoute(t *testing.T) {
	h := newRelayHarness(t)
	var gotMarker, gotToken, gotPath string
	devServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMarker = r.Header.Get(proxiedRequestHeader)
		gotToken = r.URL.Query().Get("token")
		gotPath = r.URL.Path
		_, _ = io.WriteString(w, "dev server ok")
	}))
	defer devServer.Close()
	devPort := devServer.Listener.Addr().(*net.TCPAddr).Port

	status, body := doRelayRequest(t, h.apiPortRequest(devPort, "/app", "q=1", true))

	if status != http.StatusOK || body != "dev server ok" {
		t.Fatalf("status = %d body = %q, want 200 from dev server", status, body)
	}
	if gotPath != "/app" || gotToken != "" || gotMarker != "1" {
		t.Fatalf("dev server saw path=%q token=%q marker=%q", gotPath, gotToken, gotMarker)
	}
}

// Local forward has the same loopback fallback outside container mode, so it
// must refuse the vm-agent's own listener too.
func TestLocalForwardRefusesVMAgentOwnListener(t *testing.T) {
	h := newRelayHarness(t)
	token := h.sign(auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:  "user-1",
			Audience: jwt.ClaimStrings{"local-forward"},
		},
		Workspace:      relayTestWorkspaceID,
		Node:           "node-123",
		Type:           "local-forward",
		UserID:         "user-1",
		RemotePort:     h.agentPort,
		Mode:           "http",
		LocalAuthority: "localhost:9999",
	})
	req, err := http.NewRequest(http.MethodGet,
		fmt.Sprintf("%s/workspaces/%s/local-forward/%d/git-credential?host=github.com", h.agentURL, relayTestWorkspaceID, h.agentPort), nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("X-SAM-VM-Forward-Token", token)

	status, body := doRelayRequest(t, req)

	if status != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %q)", status, body)
	}
	assertNoCredential(t, h, body)
}

func TestGitCredentialRefusesBearerlessRelayedRequest(t *testing.T) {
	cases := []struct {
		name   string
		header string
		value  string
	}{
		{name: "SAM relay marker", header: proxiedRequestHeader, value: "1"},
		{name: "API Worker container forward", header: "X-Forwarded-Host", value: "ws-x.workspaces.example.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newRelayHarness(t)
			req := httptest.NewRequest(http.MethodGet, "/git-credential?host=github.com", nil)
			req.RemoteAddr = "127.0.0.1:41000"
			req.Header.Set(tc.header, tc.value)
			rec := httptest.NewRecorder()

			h.server.handleGitCredential(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
			assertNoCredential(t, h, rec.Body.String())
		})
	}
}

// Controls: the in-workspace helper's direct loopback call still works, and a
// relayed request that carries a valid callback bearer is still authorized.
func TestGitCredentialLoopbackHelperAndBearerRelayStillAuthorized(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
	}{
		{name: "direct loopback helper, no bearer"},
		{name: "relayed with callback bearer", headers: map[string]string{
			"Authorization":      "Bearer callback-token",
			"X-Forwarded-Host":   "ws-x.workspaces.example.com",
			proxiedRequestHeader: "1",
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newRelayHarness(t)
			req := httptest.NewRequest(http.MethodGet, "/git-credential?host=github.com", nil)
			req.RemoteAddr = "127.0.0.1:41000"
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()

			h.server.handleGitCredential(rec, req)

			if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "password="+relayCanaryToken) {
				t.Fatalf("status = %d, want 200 with credential", rec.Code)
			}
		})
	}
}

func TestMarkProxiedRequestKeepsOnlyUpgradeConnectionToken(t *testing.T) {
	h := http.Header{}
	h.Add("Connection", "keep-alive, Upgrade")
	h.Add("Connection", proxiedRequestHeader)
	markProxiedRequest(h)
	if got := h.Values("Connection"); len(got) != 1 || got[0] != "Upgrade" {
		t.Fatalf("Connection = %q, want [Upgrade]", got)
	}
	if h.Get(proxiedRequestHeader) != "1" {
		t.Fatal("relay marker not set")
	}

	plain := http.Header{"Connection": {proxiedRequestHeader}}
	markProxiedRequest(plain)
	if _, ok := plain["Connection"]; ok {
		t.Fatalf("Connection = %q, want removed", plain.Values("Connection"))
	}
}

func TestIsOwnListenerTarget(t *testing.T) {
	s := &Server{config: &config.Config{Port: 8080}}
	cases := []struct {
		host string
		port int
		want bool
	}{
		{"127.0.0.1", 8080, true},
		{"localhost", 8080, true},
		{"::1", 8080, true},
		{"0.0.0.0", 8080, true},
		{"127.0.0.1", 3000, false},
		// VM control: the container bridge IP is a different host, so the same
		// port number there is the workspace's own service, not the vm-agent.
		{"172.17.0.2", 8080, false},
	}
	for _, tc := range cases {
		if got := s.isOwnListenerTarget(tc.host, tc.port); got != tc.want {
			t.Errorf("isOwnListenerTarget(%q, %d) = %v, want %v", tc.host, tc.port, got, tc.want)
		}
	}
	unset := &Server{config: &config.Config{}}
	if unset.isOwnListenerTarget("127.0.0.1", 0) {
		t.Error("an unset listen port must not match")
	}
}
