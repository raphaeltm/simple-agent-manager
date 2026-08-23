package server

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/eventstore"
	"github.com/workspace/vm-agent/internal/logreader"
	"github.com/workspace/vm-agent/internal/resourcemon"
)

const (
	diagnosticAuthNodeID  = "node-diagnostics-1"
	workspaceAID          = "ws-alpha"
	workspaceBID          = "ws-bravo"
	workspaceBCanary      = "CANARY_WS_BRAVO_NODE_DIAGNOSTIC_MARKER_12345"
	workspaceACleanSignal = "workspace-alpha-visible-event"
)

type diagnosticAuthFixture struct {
	server           *Server
	nodeToken        string
	workspaceMgmtA   string
	signingKey       *rsa.PrivateKey
	workspaceCookieA *http.Cookie
	stop             func()
}

func newDiagnosticAuthFixture(t *testing.T) diagnosticAuthFixture {
	t.Helper()
	originalDebugPackageTimeout := debugPackageTimeout
	originalDebugPackageLogLimit := debugPackageLogLimit
	debugPackageTimeout = 2 * time.Second
	debugPackageLogLimit = 10
	t.Cleanup(func() {
		debugPackageTimeout = originalDebugPackageTimeout
		debugPackageLogLimit = originalDebugPackageLogLimit
	})

	validator, signingKey := newServerJWTValidator(t, diagnosticAuthNodeID)
	sessionManager := auth.NewSessionManagerWithConfig(auth.SessionManagerConfig{
		CookieName:      "vm_session",
		Secure:          false,
		TTL:             time.Hour,
		CleanupInterval: time.Hour,
		MaxSessions:     10,
	})

	sessionA, err := sessionManager.CreateSession(&auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{Subject: "user-alpha"},
		Workspace:        workspaceAID,
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	eventStore, err := eventstore.New(t.TempDir() + "/events.db")
	if err != nil {
		t.Fatalf("eventstore.New: %v", err)
	}
	eventStore.Append(eventstore.EventRecord{
		ID:          "ws-a-event",
		NodeID:      diagnosticAuthNodeID,
		WorkspaceID: workspaceAID,
		Level:       "info",
		Type:        "workspace.alpha",
		Message:     workspaceACleanSignal,
		Detail:      map[string]interface{}{"workspace": workspaceAID},
		CreatedAt:   time.Now().UTC().Format(time.RFC3339Nano),
	})
	eventStore.Append(eventstore.EventRecord{
		ID:          "ws-b-event",
		NodeID:      diagnosticAuthNodeID,
		WorkspaceID: workspaceBID,
		Level:       "error",
		Type:        "workspace.bravo.secret",
		Message:     "workspace B secret event " + workspaceBCanary,
		Detail:      map[string]interface{}{"secret": workspaceBCanary},
		CreatedAt:   time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano),
	})

	resourceMonitor, err := resourcemon.New(t.TempDir()+"/metrics.db", time.Hour)
	if err != nil {
		t.Fatalf("resourcemon.New: %v", err)
	}

	fakeLogs := logreader.NewReaderWithExecutor(func(ctx context.Context, name string, args ...string) *exec.Cmd {
		if name == "docker" && len(args) > 0 && args[0] == "ps" {
			return exec.CommandContext(ctx, "printf", "%s", `{"ID":"bravo12345678","Names":"ws-bravo-devcontainer","Image":"repo:latest","State":"running","Status":"Up 1 minute"}`+"\n")
		}
		if name == "docker" && len(args) > 0 && args[0] == "logs" {
			line := "2026-08-23T12:00:00Z workspace B log leaked " + workspaceBCanary + "\n"
			return exec.CommandContext(ctx, "printf", "%s", line)
		}
		return exec.CommandContext(ctx, "printf", "")
	})

	srv := &Server{
		config: &config.Config{
			NodeID:                    diagnosticAuthNodeID,
			WSReadBufferSize:          1024,
			WSWriteBufferSize:         1024,
			LogStreamPingInterval:     time.Hour,
			LogStreamPongTimeout:      time.Hour,
			LogStreamPingWriteTimeout: time.Second,
		},
		jwtValidator:    validator,
		sessionManager:  sessionManager,
		nodeEvents:      []EventRecord{{ID: "node-event", NodeID: diagnosticAuthNodeID, WorkspaceID: workspaceBID, Level: "error", Type: "node.secret", Message: "node event includes " + workspaceBCanary, Detail: map[string]interface{}{"secret": workspaceBCanary}, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}},
		workspaceEvents: map[string][]EventRecord{workspaceAID: {{ID: "workspace-a", WorkspaceID: workspaceAID, Level: "info", Type: "workspace.alpha", Message: workspaceACleanSignal, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}}, workspaceBID: {{ID: "workspace-b", WorkspaceID: workspaceBID, Level: "error", Type: "workspace.bravo", Message: workspaceBCanary, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}}},
		eventStore:      eventStore,
		resourceMonitor: resourceMonitor,
		logReader:       fakeLogs,
	}

	return diagnosticAuthFixture{
		server:           srv,
		nodeToken:        signServerTestToken(t, signingKey, diagnosticAuthNodeID, ""),
		workspaceMgmtA:   signServerTestToken(t, signingKey, diagnosticAuthNodeID, workspaceAID),
		signingKey:       signingKey,
		workspaceCookieA: &http.Cookie{Name: "vm_session", Value: sessionA.ID},
		stop: func() {
			_ = eventStore.Close()
			_ = resourceMonitor.Close()
			sessionManager.Stop()
			validator.Close()
		},
	}
}

func TestNodeWideDiagnosticsRejectWorkspaceAuthAcrossAffectedEndpoints(t *testing.T) {
	fx := newDiagnosticAuthFixture(t)
	defer fx.stop()

	tests := []struct {
		name    string
		path    string
		handler http.HandlerFunc
	}{
		{name: "events", path: "/events", handler: fx.server.handleListNodeEvents},
		{name: "events export", path: "/events/export", handler: fx.server.handleExportEvents},
		{name: "metrics export", path: "/metrics/export", handler: fx.server.handleExportMetrics},
		{name: "logs", path: "/logs?source=docker&level=debug", handler: fx.server.handleLogs},
		{name: "containers", path: "/containers", handler: fx.server.handleContainers},
		{name: "debug package", path: "/debug-package", handler: fx.server.handleDebugPackage},
		{name: "system info", path: "/system-info", handler: fx.server.handleSystemInfo},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			req.AddCookie(fx.workspaceCookieA)
			rec := httptest.NewRecorder()

			tt.handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusUnauthorized, rec.Body.String())
			}
			assertBodyDoesNotContainCanary(t, rec.Body.Bytes())
			if strings.Contains(rec.Header().Get("Content-Type"), "gzip") {
				t.Fatalf("unauthorized %s response must not start a debug archive", tt.name)
			}
			if tt.name == "debug package" {
				assertNotDebugArchive(t, rec)
			}
		})
	}
}

func TestNodeWideLogStreamRejectsWorkspaceAuthBeforeUpgrade(t *testing.T) {
	fx := newDiagnosticAuthFixture(t)
	defer fx.stop()

	ts := httptest.NewServer(http.HandlerFunc(fx.server.handleLogStream))
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/logs/stream?source=docker&level=debug"
	headers := http.Header{}
	headers.Add("Cookie", fx.workspaceCookieA.String())

	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if conn != nil {
		_ = conn.Close()
	}
	if err == nil {
		t.Fatal("expected WebSocket upgrade to fail under workspace cookie auth")
	}
	if resp == nil {
		t.Fatalf("expected HTTP response for failed upgrade: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d; body=%s", resp.StatusCode, http.StatusUnauthorized, string(body))
	}
	assertBodyDoesNotContainCanary(t, body)
}

func TestNodeWideLogStreamAcceptsNodeScopedManagementToken(t *testing.T) {
	fx := newDiagnosticAuthFixture(t)
	defer fx.stop()

	ts := httptest.NewServer(http.HandlerFunc(fx.server.handleLogStream))
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/logs/stream?source=docker&level=debug&token=" + url.QueryEscape(fx.nodeToken)
	headers := http.Header{}
	headers.Set("X-SAM-Node-Id", diagnosticAuthNodeID)

	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		if resp != nil && resp.Body != nil {
			body, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			t.Fatalf("expected WebSocket upgrade to succeed, status=%d body=%s err=%v", resp.StatusCode, string(body), err)
		}
		t.Fatalf("expected WebSocket upgrade to succeed: %v", err)
	}
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read first log stream message: %v", err)
	}
	if !bytes.Contains(msg, []byte(workspaceBCanary)) {
		t.Fatalf("management-token log stream did not include expected node observability data: %s", string(msg))
	}
}

func TestNodeWideDiagnosticsAcceptNodeScopedManagementToken(t *testing.T) {
	fx := newDiagnosticAuthFixture(t)
	defer fx.stop()

	tests := []nodeWideManagementTokenCase{
		{name: "events", path: "/events", handler: fx.server.handleListNodeEvents, wantCT: "application/json", wantBody: workspaceBCanary},
		{name: "events export", path: "/events/export", handler: fx.server.handleExportEvents, wantCT: "application/x-sqlite3", wantBody: workspaceBCanary},
		{name: "metrics export", path: "/metrics/export", handler: fx.server.handleExportMetrics, wantCT: "application/x-sqlite3", readLimit: 4096},
		{name: "logs", path: "/logs?source=docker&level=debug", handler: fx.server.handleLogs, wantCT: "application/json", wantBody: workspaceBCanary},
		{name: "containers", path: "/containers", handler: fx.server.handleContainers, wantCT: "application/json", wantBody: "ws-bravo-devcontainer"},
		{name: "debug package via query token", path: "/debug-package", handler: fx.server.handleDebugPackage, useQuery: true, wantCT: "application/gzip", wantBody: workspaceBCanary},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertNodeWideManagementTokenAccepted(t, fx, tt)
		})
	}
}

func TestWorkspaceScopedEventsRemainScopedAndRedactedFromOtherWorkspaceCanaries(t *testing.T) {
	fx := newDiagnosticAuthFixture(t)
	defer fx.stop()

	req := httptest.NewRequest(http.MethodGet, "/workspaces/"+workspaceAID+"/events", nil)
	req.SetPathValue("workspaceId", workspaceAID)
	req.Header.Set("X-SAM-Workspace-Id", workspaceAID)
	req.AddCookie(fx.workspaceCookieA)
	rec := httptest.NewRecorder()

	fx.server.handleListWorkspaceEvents(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, workspaceACleanSignal) {
		t.Fatalf("workspace-scoped response missing workspace A event: %s", body)
	}
	if strings.Contains(body, workspaceBCanary) || strings.Contains(body, workspaceBID) {
		t.Fatalf("workspace-scoped response leaked workspace B data: %s", body)
	}
}

func TestNodeWideDiagnosticsRejectWorkspaceScopedAndInvalidTokensWithoutCookieFallback(t *testing.T) {
	fx := newDiagnosticAuthFixture(t)
	defer fx.stop()

	t.Run("workspace scoped management token cannot be replayed against node-wide route", func(t *testing.T) {
		assertNodeEventsDenied(t, fx, "Bearer "+fx.workspaceMgmtA, http.StatusForbidden)
	})

	t.Run("invalid bearer is not bypassed by valid query token or workspace cookie", func(t *testing.T) {
		assertInvalidBearerBlocksEventFallback(t, fx)
	})

	t.Run("invalid query token is not bypassed by workspace cookie for debug archive", func(t *testing.T) {
		assertDebugPackageQueryTokenDenied(t, fx, "not-a-valid-jwt")
	})

	t.Run("expired query token is not bypassed by workspace cookie for debug archive", func(t *testing.T) {
		expired := signServerTestTokenWithExpiry(t, fx.signingKey, diagnosticAuthNodeID, "", time.Now().Add(-time.Minute))
		assertDebugPackageQueryTokenDenied(t, fx, expired)
	})

	t.Run("invalid query token is not bypassed by workspace cookie for websocket", func(t *testing.T) {
		assertLogStreamQueryTokenDenied(t, fx, "not-a-valid-jwt")
	})

	t.Run("expired query token is not bypassed by workspace cookie for websocket", func(t *testing.T) {
		expired := signServerTestTokenWithExpiry(t, fx.signingKey, diagnosticAuthNodeID, "", time.Now().Add(-time.Minute))
		assertLogStreamQueryTokenDenied(t, fx, expired)
	})

	t.Run("valid bearer takes precedence over invalid query token", func(t *testing.T) {
		assertValidBearerOverridesInvalidQuery(t, fx)
	})

	t.Run("expired node token is rejected", func(t *testing.T) {
		expired := signServerTestTokenWithExpiry(t, fx.signingKey, diagnosticAuthNodeID, "", time.Now().Add(-time.Minute))
		assertExpiredNodeBearerDenied(t, fx, expired)
	})
}

type nodeWideManagementTokenCase struct {
	name      string
	path      string
	handler   http.HandlerFunc
	useQuery  bool
	wantCT    string
	wantBody  string
	readLimit int64
}

func assertNodeWideManagementTokenAccepted(t *testing.T, fx diagnosticAuthFixture, tt nodeWideManagementTokenCase) {
	t.Helper()
	rec := serveNodeWideManagementTokenRequest(t, fx, tt)
	assertStatus(t, rec.Code, http.StatusOK, rec.Body.String())
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, tt.wantCT) {
		t.Fatalf("Content-Type = %q, want containing %q", got, tt.wantCT)
	}
	assertExpectedManagementBody(t, rec.Body.Bytes(), tt)
}

func serveNodeWideManagementTokenRequest(t *testing.T, fx diagnosticAuthFixture, tt nodeWideManagementTokenCase) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, pathWithOptionalToken(t, tt.path, tt.useQuery, fx.nodeToken), nil)
	if !tt.useQuery {
		req.Header.Set("Authorization", "Bearer "+fx.nodeToken)
	}
	req.Header.Set("X-SAM-Node-Id", diagnosticAuthNodeID)
	rec := httptest.NewRecorder()
	tt.handler.ServeHTTP(rec, req)
	return rec
}

func pathWithOptionalToken(t *testing.T, path string, useQuery bool, token string) string {
	t.Helper()
	if !useQuery {
		return path
	}
	parsed, err := url.Parse(path)
	if err != nil {
		t.Fatalf("parse test path: %v", err)
	}
	q := parsed.Query()
	q.Set("token", token)
	parsed.RawQuery = q.Encode()
	return parsed.String()
}

func assertExpectedManagementBody(t *testing.T, responseBody []byte, tt nodeWideManagementTokenCase) {
	t.Helper()
	if tt.wantBody == "" {
		return
	}
	body := limitedBody(responseBody, tt.readLimit)
	if strings.Contains(tt.wantCT, "gzip") {
		body = mustReadTarGz(t, responseBody)
	}
	if !bytes.Contains(body, []byte(tt.wantBody)) {
		t.Fatalf("management-token response did not include expected observability data %q", tt.wantBody)
	}
}

func limitedBody(body []byte, limit int64) []byte {
	if limit <= 0 || int64(len(body)) <= limit {
		return body
	}
	return body[:limit]
}

func assertNodeEventsDenied(t *testing.T, fx diagnosticAuthFixture, authorization string, wantStatus int) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	req.Header.Set("Authorization", authorization)
	rec := httptest.NewRecorder()
	fx.server.handleListNodeEvents(rec, req)
	assertStatus(t, rec.Code, wantStatus, rec.Body.String())
	assertBodyDoesNotContainCanary(t, rec.Body.Bytes())
}

func assertInvalidBearerBlocksEventFallback(t *testing.T, fx diagnosticAuthFixture) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/events?token="+url.QueryEscape(fx.nodeToken), nil)
	req.Header.Set("Authorization", "Bearer not-a-valid-jwt")
	req.AddCookie(fx.workspaceCookieA)
	rec := httptest.NewRecorder()
	fx.server.handleListNodeEvents(rec, req)
	assertStatus(t, rec.Code, http.StatusUnauthorized, rec.Body.String())
	assertBodyDoesNotContainCanary(t, rec.Body.Bytes())
}

func assertDebugPackageQueryTokenDenied(t *testing.T, fx diagnosticAuthFixture, token string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/debug-package?token="+url.QueryEscape(token), nil)
	req.AddCookie(fx.workspaceCookieA)
	rec := httptest.NewRecorder()
	fx.server.handleDebugPackage(rec, req)
	assertStatus(t, rec.Code, http.StatusUnauthorized, rec.Body.String())
	assertBodyDoesNotContainCanary(t, rec.Body.Bytes())
	assertNotDebugArchive(t, rec)
}

func assertLogStreamQueryTokenDenied(t *testing.T, fx diagnosticAuthFixture, token string) {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(fx.server.handleLogStream))
	defer ts.Close()

	body, status := dialRejectedLogStream(t, ts.URL, token, fx.workspaceCookieA.String())
	assertStatus(t, status, http.StatusUnauthorized, string(body))
	assertBodyDoesNotContainCanary(t, body)
}

func dialRejectedLogStream(t *testing.T, serverURL string, token string, cookie string) ([]byte, int) {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(serverURL, "http") + "/logs/stream?source=docker&level=debug&token=" + url.QueryEscape(token)
	headers := http.Header{}
	headers.Add("Cookie", cookie)

	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if conn != nil {
		_ = conn.Close()
	}
	if err == nil {
		t.Fatal("expected WebSocket upgrade to fail")
	}
	if resp == nil {
		t.Fatalf("expected HTTP response for failed upgrade: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return body, resp.StatusCode
}

func assertValidBearerOverridesInvalidQuery(t *testing.T, fx diagnosticAuthFixture) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/logs?source=docker&level=debug&token=not-a-valid-jwt", nil)
	req.Header.Set("Authorization", "Bearer "+fx.nodeToken)
	req.AddCookie(fx.workspaceCookieA)
	rec := httptest.NewRecorder()
	fx.server.handleLogs(rec, req)
	assertStatus(t, rec.Code, http.StatusOK, rec.Body.String())
	if !bytes.Contains(rec.Body.Bytes(), []byte(workspaceBCanary)) {
		t.Fatalf("valid bearer response did not include expected node observability data: %s", rec.Body.String())
	}
}

func assertExpiredNodeBearerDenied(t *testing.T, fx diagnosticAuthFixture, token string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/debug-package", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.AddCookie(fx.workspaceCookieA)
	rec := httptest.NewRecorder()
	fx.server.handleDebugPackage(rec, req)
	assertStatus(t, rec.Code, http.StatusUnauthorized, rec.Body.String())
	assertBodyDoesNotContainCanary(t, rec.Body.Bytes())
	assertNotDebugArchive(t, rec)
}

func assertStatus(t *testing.T, got int, want int, body string) {
	t.Helper()
	if got != want {
		t.Fatalf("status = %d, want %d; body=%s", got, want, body)
	}
}

func assertBodyDoesNotContainCanary(t *testing.T, body []byte) {
	t.Helper()
	if bytes.Contains(body, []byte(workspaceBCanary)) || bytes.Contains(body, []byte(workspaceBID)) {
		t.Fatalf("response leaked workspace B canary/body=%q", string(body))
	}
}

func assertNotDebugArchive(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if strings.Contains(rec.Header().Get("Content-Type"), "gzip") {
		t.Fatal("denied debug-package response must not use gzip content type")
	}
	if rec.Header().Get("Content-Disposition") != "" {
		t.Fatalf("denied debug-package response must not use attachment disposition: %q", rec.Header().Get("Content-Disposition"))
	}
	body := rec.Body.Bytes()
	if len(body) >= 2 && body[0] == 0x1f && body[1] == 0x8b {
		t.Fatal("denied debug-package response must not contain gzip magic bytes")
	}
}

func mustReadTarGz(t *testing.T, data []byte) []byte {
	t.Helper()
	gr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	defer gr.Close()

	tr := tar.NewReader(gr)
	var out bytes.Buffer
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("tar.Next: %v", err)
		}
		out.WriteString(hdr.Name)
		out.WriteByte('\n')
		if _, err := io.Copy(&out, tr); err != nil {
			t.Fatalf("read tar member %s: %v", hdr.Name, err)
		}
		out.WriteByte('\n')
	}
	return out.Bytes()
}

func newServerJWTValidator(t *testing.T, nodeID string) (*auth.JWTValidator, *rsa.PrivateKey) {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}
	pubKey := privateKey.Public().(*rsa.PublicKey)
	jwksJSON := buildServerTestJWKSJSON(pubKey)

	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(jwksJSON)
	}))
	t.Cleanup(jwksServer.Close)

	validator, err := auth.NewJWTValidator(jwksServer.URL, nodeID, "test-issuer", "workspace-terminal")
	if err != nil {
		t.Fatalf("auth.NewJWTValidator: %v", err)
	}
	return validator, privateKey
}

func buildServerTestJWKSJSON(pub *rsa.PublicKey) []byte {
	n := base64.RawURLEncoding.EncodeToString(pub.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes())
	data, _ := json.Marshal(map[string]interface{}{
		"keys": []map[string]interface{}{{
			"kty": "RSA",
			"alg": "RS256",
			"use": "sig",
			"kid": "diagnostic-test-key",
			"n":   n,
			"e":   e,
		}},
	})
	return data
}

func signServerTestToken(t *testing.T, key *rsa.PrivateKey, nodeID, workspaceID string) string {
	t.Helper()
	return signServerTestTokenWithExpiry(t, key, nodeID, workspaceID, time.Now().Add(time.Hour))
}

func signServerTestTokenWithExpiry(t *testing.T, key *rsa.PrivateKey, nodeID, workspaceID string, expiresAt time.Time) string {
	t.Helper()
	claims := auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "test-issuer",
			Subject:   "user-alpha",
			Audience:  jwt.ClaimStrings{"node-management"},
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
		Node: nodeID,
		Type: "node-management",
	}
	if workspaceID != "" {
		claims.Workspace = workspaceID
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = "diagnostic-test-key"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}
