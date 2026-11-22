package server

import (
	"crypto/rsa"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/deploy"
)

const (
	appIngressNodeID  = "node-app-ingress"
	appIngressHost    = "r1-web-80-env1.apps.box.example.test"
	appIngressForeign = "r1-web-80-env2.apps.box.example.test"
)

// signAppIngressTestToken signs the credential box Caddy presents (app-route-token.ts shape).
func signAppIngressTestToken(t *testing.T, key *rsa.PrivateKey, nodeID, host string) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "test-issuer",
			Subject:   "user-alpha",
			Audience:  jwt.ClaimStrings{"node-app-ingress"},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(5 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
		Node:    nodeID,
		Type:    "app-ingress",
		AppHost: host,
	})
	token.Header["kid"] = "diagnostic-test-key"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign app ingress token: %v", err)
	}
	return signed
}

type appIngressFixture struct {
	mgmt      string
	otherHost string
	server    *Server
	handler   http.Handler
	token     string
	foreign   string
	upstream  []*http.Request
	bodies    []string
}

// newAppIngressFixture builds a deployment node in tunnel app ingress with one active environment
// whose applied snippet serves appIngressHost. The node Caddy is stood in for by a loopback
// server on the ingress port that records what reaches it.
func newAppIngressFixture(t *testing.T, ingress string) *appIngressFixture {
	t.Helper()
	fx := &appIngressFixture{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		fx.upstream = append(fx.upstream, r.Clone(r.Context()))
		fx.bodies = append(fx.bodies, string(body))
		_, _ = w.Write([]byte("app:" + r.Host))
	}))
	t.Cleanup(upstream.Close)
	_, portText, _ := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))
	port, _ := strconv.Atoi(portText)

	validator, key := newServerJWTValidator(t, appIngressNodeID)
	t.Cleanup(validator.Close)
	caddyfile := filepath.Join(t.TempDir(), "Caddyfile")
	engine := deploy.NewEngine(nil, nil, deploy.EngineConfig{
		EnvironmentID: "env-1", NodeID: appIngressNodeID, CaddyfilePath: caddyfile, AppIngressLoopbackPort: port,
	})
	snippet, err := deploy.GenerateCaddySnippet([]deploy.RouteTarget{
		{Hostname: appIngressHost, Service: "web", ContainerPort: 80, HostPort: 35000},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	sites := filepath.Join(filepath.Dir(caddyfile), "sites")
	if err := os.MkdirAll(sites, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sites, deploy.SafeEnvironmentFilePart("env-1")+".caddy"), []byte(snippet), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := &Server{
		config: &config.Config{
			NodeID: appIngressNodeID, Role: config.RoleDeployment,
			DeployAppIngress: ingress, DeployAppIngressPort: port,
		},
		jwtValidator:        validator,
		deployEngines:       map[string]*deploy.Engine{"env-1": engine},
		deployCaddyfilePath: caddyfile,
	}
	srv.config.AllowedOrigins = []string{"https://*.box.example.test"}
	mux := http.NewServeMux()
	srv.setupRoutes(mux)
	srv.buildHTTPServers(mux)
	fx.handler = srv.httpServer.Handler
	fx.server = srv
	fx.token = signAppIngressTestToken(t, key, appIngressNodeID, appIngressHost)
	fx.foreign = signAppIngressTestToken(t, key, "node-other", appIngressHost)
	fx.otherHost = signAppIngressTestToken(t, key, appIngressNodeID, appIngressForeign)
	fx.mgmt = signServerTestToken(t, key, appIngressNodeID, "")
	return fx
}

func (fx *appIngressFixture) do(host, rest string, headers map[string]string) *httptest.ResponseRecorder {
	return fx.doMethod(http.MethodPost, host, rest, headers)
}

func (fx *appIngressFixture) doMethod(method, host, rest string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/deployment/app-ingress/"+host+rest, strings.NewReader("payload"))
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	fx.handler.ServeHTTP(rec, req)
	return rec
}

func (fx *appIngressFixture) samHeaders(token, nodeID string) map[string]string {
	return map[string]string{"X-SAM-Node-Authorization": "Bearer " + token, "X-SAM-Node-Id": nodeID}
}

func TestAppIngress_ProxiesAnAppliedRouteToLoopbackCaddyKeepingAppCredentials(t *testing.T) {
	fx := newAppIngressFixture(t, config.DeployAppIngressTunnel)
	headers := fx.samHeaders(fx.token, appIngressNodeID)
	headers["Authorization"] = "Basic app-user"
	headers["Cookie"] = "app_session=1"
	headers["X-SAM-Upstream-Uri"] = "/forged"
	headers["Forwarded"] = "for=forged"
	headers["Connection"] = "X-Forwarded-Host"
	rec := fx.do(appIngressHost, "/api/items%2Fraw?q=1&token=app", headers)
	if rec.Code != http.StatusOK || rec.Body.String() != "app:"+appIngressHost {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
	if len(fx.upstream) != 1 {
		t.Fatalf("upstream requests = %d", len(fx.upstream))
	}
	got := fx.upstream[0]
	if got.Host != appIngressHost || got.URL.EscapedPath() != "/api/items%2Fraw" || got.URL.RawQuery != "q=1&token=app" {
		t.Fatalf("forwarded host=%q path=%q query=%q", got.Host, got.URL.EscapedPath(), got.URL.RawQuery)
	}
	if got.Method != http.MethodPost || fx.bodies[0] != "payload" {
		t.Fatalf("method=%s body=%q", got.Method, fx.bodies[0])
	}
	if got.Header.Get("Authorization") != "Basic app-user" || got.Header.Get("Cookie") != "app_session=1" {
		t.Fatalf("app credentials not kept: %v", got.Header)
	}
	for name := range got.Header {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "x-sam-") {
			t.Fatalf("SAM header %s reached the app", name)
		}
	}
	if got.Header.Get("Forwarded") != "" {
		t.Fatalf("client Forwarded header reached the app")
	}
	if got.Header.Get("X-Forwarded-Proto") != "https" || got.Header.Get("X-Forwarded-Host") != appIngressHost {
		t.Fatalf("forwarded headers: %v", got.Header)
	}
}

func TestAppIngress_Refusals(t *testing.T) {
	cases := []struct {
		name    string
		ingress string
		host    string
		headers func(*appIngressFixture) map[string]string
		want    int
	}{
		// A hosted (public-ingress) node never serves the route.
		{"public ingress node", "", appIngressHost, func(fx *appIngressFixture) map[string]string {
			return fx.samHeaders(fx.token, appIngressNodeID)
		}, http.StatusNotFound},
		{"no SAM token (app Authorization only)", config.DeployAppIngressTunnel, appIngressHost, func(*appIngressFixture) map[string]string {
			return map[string]string{"X-SAM-Node-Id": appIngressNodeID}
		}, http.StatusUnauthorized},
		{"token for another node", config.DeployAppIngressTunnel, appIngressHost, func(fx *appIngressFixture) map[string]string {
			return fx.samHeaders(fx.foreign, appIngressNodeID)
		}, http.StatusUnauthorized},
		// A node-wide management token is not an app-ingress credential.
		{"management token", config.DeployAppIngressTunnel, appIngressHost, func(fx *appIngressFixture) map[string]string {
			return fx.samHeaders(fx.mgmt, appIngressNodeID)
		}, http.StatusUnauthorized},
		// A credential minted for another hostname (another environment's app) does not transfer.
		{"token for another hostname", config.DeployAppIngressTunnel, appIngressHost, func(fx *appIngressFixture) map[string]string {
			return fx.samHeaders(fx.otherHost, appIngressNodeID)
		}, http.StatusUnauthorized},
		{"routed to another node", config.DeployAppIngressTunnel, appIngressHost, func(fx *appIngressFixture) map[string]string {
			return fx.samHeaders(fx.token, "node-other")
		}, http.StatusForbidden},
		{"routed node id missing", config.DeployAppIngressTunnel, appIngressHost, func(fx *appIngressFixture) map[string]string {
			return map[string]string{"X-SAM-Node-Authorization": "Bearer " + fx.token}
		}, http.StatusForbidden},
		// Another environment's hostname (another project's app, or a route this node never applied).
		{"hostname not applied on this node", config.DeployAppIngressTunnel, appIngressForeign, func(fx *appIngressFixture) map[string]string {
			return fx.samHeaders(fx.otherHost, appIngressNodeID)
		}, http.StatusNotFound},
		{"uppercase hostname", config.DeployAppIngressTunnel, strings.ToUpper(appIngressHost), func(fx *appIngressFixture) map[string]string {
			return fx.samHeaders(fx.token, appIngressNodeID)
		}, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newAppIngressFixture(t, tc.ingress)
			rec := fx.do(tc.host, "/", tc.headers(fx))
			if rec.Code != tc.want {
				t.Fatalf("status=%d want %d body=%s", rec.Code, tc.want, rec.Body.String())
			}
			if len(fx.upstream) != 0 {
				t.Fatalf("a refused request reached the app")
			}
		})
	}
}

// The agent's CORS middleware answers OPTIONS itself; an app's preflight must reach the app,
// and a non-canonical app path must reach it as sent rather than being redirected.
func TestAppIngress_PreflightAndPathsReachTheApp(t *testing.T) {
	fx := newAppIngressFixture(t, config.DeployAppIngressTunnel)
	headers := fx.samHeaders(fx.token, appIngressNodeID)
	headers["Origin"] = "https://" + appIngressHost
	rec := fx.doMethod(http.MethodOptions, appIngressHost, "/api", headers)
	if rec.Code != http.StatusOK || len(fx.upstream) != 1 || fx.upstream[0].Method != http.MethodOptions {
		t.Fatalf("preflight: status=%d upstream=%d", rec.Code, len(fx.upstream))
	}
	if rec.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("the agent's own CORS headers were added to an app response")
	}
	for rest, want := range map[string]string{"": "/", "/": "/", "//a/./b?token=x": "//a/./b"} {
		rec := fx.doMethod(http.MethodGet, appIngressHost, rest, fx.samHeaders(fx.token, appIngressNodeID))
		got := fx.upstream[len(fx.upstream)-1]
		if rec.Code != http.StatusOK || got.URL.Path != want {
			t.Fatalf("%q: status=%d forwarded path=%q want %q", rest, rec.Code, got.URL.Path, want)
		}
	}
}

// Control: every other agent route still goes through the agent's middleware.
func TestAppIngress_OtherRoutesKeepAgentMiddleware(t *testing.T) {
	fx := newAppIngressFixture(t, config.DeployAppIngressTunnel)
	req := httptest.NewRequest(http.MethodOptions, "/workspaces", nil)
	rec := httptest.NewRecorder()
	fx.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || len(fx.upstream) != 0 {
		t.Fatalf("status=%d upstream=%d", rec.Code, len(fx.upstream))
	}
}

// An app WebSocket upgrades through the agent to loopback Caddy, over a real listener.
func TestAppIngress_WebSocketUpgradeReachesTheApp(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteMessage(websocket.TextMessage, []byte("hello from "+r.Host))
	}))
	defer app.Close()
	_, portText, _ := net.SplitHostPort(strings.TrimPrefix(app.URL, "http://"))
	port, _ := strconv.Atoi(portText)

	fx := newAppIngressFixture(t, config.DeployAppIngressTunnel)
	fx.server.config.DeployAppIngressPort = port
	agent := httptest.NewServer(fx.handler)
	defer agent.Close()

	header := http.Header{}
	for name, value := range fx.samHeaders(fx.token, appIngressNodeID) {
		header.Set(name, value)
	}
	conn, resp, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(agent.URL, "http")+"/deployment/app-ingress/"+appIngressHost+"/socket", header)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("dial: %v (status %d)", err, status)
	}
	defer conn.Close()
	_, message, err := conn.ReadMessage()
	if err != nil || string(message) != "hello from "+appIngressHost {
		t.Fatalf("message=%q err=%v", message, err)
	}
}

// A loopback Caddy that is not listening (stopped, restarting) is a 502, not a hang or a 200.
func TestAppIngress_UpstreamDownIs502(t *testing.T) {
	fx := newAppIngressFixture(t, config.DeployAppIngressTunnel)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	fx.server.config.DeployAppIngressPort = listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	rec := fx.do(appIngressHost, "/", fx.samHeaders(fx.token, appIngressNodeID))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

// The app-ingress credential opens nothing but app ingress: the management API refuses it.
func TestAppIngressTokenIsNotAManagementToken(t *testing.T) {
	fx := newAppIngressFixture(t, config.DeployAppIngressTunnel)
	for _, header := range []string{"Authorization", "X-SAM-Node-Authorization"} {
		req := httptest.NewRequest(http.MethodGet, "/workspaces", nil)
		req.Header.Set(header, "Bearer "+fx.token)
		req.Header.Set("X-SAM-Node-Id", appIngressNodeID)
		rec := httptest.NewRecorder()
		fx.handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status=%d", header, rec.Code)
		}
	}
}

// An app upload slower than the agent's own HTTP_READ_TIMEOUT still reaches the app: the read
// deadline is lifted for app ingress only.
func TestAppIngress_SlowUploadOutlivesTheAgentReadTimeout(t *testing.T) {
	fx := newAppIngressFixture(t, config.DeployAppIngressTunnel)
	agent := httptest.NewUnstartedServer(fx.handler)
	agent.Config.ReadTimeout = 300 * time.Millisecond
	agent.Start()
	defer agent.Close()

	body, writer := io.Pipe()
	go func() {
		for i := 0; i < 5; i++ {
			_, _ = writer.Write([]byte("chunk-"))
			time.Sleep(200 * time.Millisecond)
		}
		_ = writer.Close()
	}()
	req, err := http.NewRequest(http.MethodPost, agent.URL+"/deployment/app-ingress/"+appIngressHost+"/upload", body)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range fx.samHeaders(fx.token, appIngressNodeID) {
		req.Header.Set(name, value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || len(fx.bodies) != 1 || fx.bodies[0] != strings.Repeat("chunk-", 5) {
		t.Fatalf("status=%d bodies=%q", resp.StatusCode, fx.bodies)
	}
}

// After an agent restart the engines are rebuilt only on the next heartbeat; the app, whose Caddy
// snippet and containers are still running, keeps being served in between.
func TestAppIngress_ServesAppliedRoutesBeforeEnginesAreRebuilt(t *testing.T) {
	fx := newAppIngressFixture(t, config.DeployAppIngressTunnel)
	fx.server.deployMu.Lock()
	fx.server.deployEngines = map[string]*deploy.Engine{}
	fx.server.deployMu.Unlock()
	rec := fx.do(appIngressHost, "/", fx.samHeaders(fx.token, appIngressNodeID))
	if rec.Code != http.StatusOK || len(fx.upstream) != 1 {
		t.Fatalf("status=%d upstream=%d body=%s", rec.Code, len(fx.upstream), rec.Body.String())
	}
}
