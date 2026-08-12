package server

import (
	"crypto/rsa"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
)

func TestPortProxyIsolatesCredentialsAndResponseCookies(t *testing.T) {
	const workspaceID = "01KR1000000000000000000001"
	validator, privateKey := newWorkspaceCreateJWTValidator(t, "node-1")
	samToken := signPreviewWorkspaceToken(t, privateKey, workspaceID)

	var gotAuthorization, gotCookie, gotQuery string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuthorization = r.Header.Get("Authorization")
		gotCookie = r.Header.Get("Cookie")
		gotQuery = r.URL.RawQuery
		w.Header().Add("Set-Cookie", "sam_port_access=evil; Path=/")
		w.Header().Add("Set-Cookie", "vm_session=evil; Path=/")
		w.Header().Add("Set-Cookie", "vm_session_"+workspaceID+"=evil; Path=/")
		w.Header().Add("Set-Cookie", "__Secure-better-auth.session_token=evil; Path=/; Secure")
		w.Header().Add("Set-Cookie", "vm_session_extension=ordinary; Path=/")
		w.Header().Add("Set-Cookie", "better-auth.session_extension=ordinary; Path=/")
		w.Header().Add("Set-Cookie", "preview_session=ordinary; Path=/; HttpOnly")
		w.Header().Add("Set-Cookie", "preview_parent=ordinary; Domain=.example.com; Path=/")
		w.Header().Set("Clear-Site-Data", `"cache", "cookies", "storage"`)
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	}))
	defer backend.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: "https://api.example.com",
			CookieName:      "vm_session",
		},
		jwtValidator: validator,
	}
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, backend.URL+"/ignored?token=backend-token&view=compact", nil)
	req.Header.Set("Authorization", "Bearer "+samToken)
	req.Header.Set("Cookie", strings.Join([]string{
		"sam_port_access=access-token",
		"vm_session=shared-session",
		"vm_session_" + workspaceID + "=workspace-session",
		"__Secure-better-auth.session_token=control-plane-session",
		"vm_session_extension=ordinary-extension",
		"better-auth.session_extension=ordinary-extension",
		"preview_theme=dark",
	}, "; "))

	s.servePortProxy(recorder, req, workspaceID, 3000, backend.URL, "/")

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	if gotAuthorization != "" {
		t.Fatalf("SAM Authorization reached preview app: %q", gotAuthorization)
	}
	if gotCookie != "vm_session_extension=ordinary-extension; better-auth.session_extension=ordinary-extension; preview_theme=dark" {
		t.Fatalf("Cookie = %q, want only ordinary preview cookie", gotCookie)
	}
	if gotQuery != "view=compact" {
		t.Fatalf("query = %q, want only application query", gotQuery)
	}
	setCookies := strings.Join(recorder.Result().Header.Values("Set-Cookie"), "\n")
	for _, blocked := range []string{"sam_port_access=", "vm_session=", "vm_session_" + workspaceID + "=", "better-auth.session_token="} {
		if strings.Contains(setCookies, blocked) {
			t.Errorf("reserved response cookie %q was not removed: %s", blocked, setCookies)
		}
	}
	for _, preserved := range []string{"preview_session=ordinary", "preview_parent=ordinary", "vm_session_extension=ordinary", "better-auth.session_extension=ordinary"} {
		if !strings.Contains(setCookies, preserved) {
			t.Errorf("ordinary response cookie %q was not preserved: %s", preserved, setCookies)
		}
	}
	if strings.Contains(strings.ToLower(setCookies), "domain=") {
		t.Errorf("preview response cookie retained a Domain attribute: %s", setCookies)
	}
	if got := recorder.Result().Header.Get("Clear-Site-Data"); got != `"cache", "storage"` {
		t.Fatalf("Clear-Site-Data = %q", got)
	}
}

func TestPortProxyPreservesApplicationAuthorization(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer app-token" {
			t.Errorf("Authorization = %q, want application bearer", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()

	s := &Server{config: &config.Config{ControlPlaneURL: "https://api.example.com", CookieName: "vm_session"}}
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, backend.URL, nil)
	req.Header.Set("Authorization", "Bearer app-token")
	s.servePortProxy(recorder, req, "WS001", 3000, backend.URL, "/")

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", recorder.Code)
	}
}

func TestPortProxyPreservesApplicationWebSocketUpgrade(t *testing.T) {
	backendUpgrader := websocket.Upgrader{CheckOrigin: func(_ *http.Request) bool { return true }}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer app-token" {
			t.Errorf("Authorization = %q, want application bearer", got)
		}
		if got := r.Header.Get("Cookie"); got != "preview_theme=dark" {
			t.Errorf("Cookie = %q, want application cookie", got)
		}
		if got := r.URL.RawQuery; got != "channel=app" {
			t.Errorf("query = %q, want only application query", got)
		}
		responseHeaders := http.Header{}
		responseHeaders.Add("Set-Cookie", "preview_socket=active; Domain=.example.com; Path=/")
		connection, err := backendUpgrader.Upgrade(w, r, responseHeaders)
		if err != nil {
			t.Errorf("backend upgrade: %v", err)
			return
		}
		defer connection.Close()
		_ = connection.WriteMessage(websocket.TextMessage, []byte("connected"))
	}))
	defer backend.Close()

	s := &Server{config: &config.Config{ControlPlaneURL: "https://api.example.com", CookieName: "vm_session"}}
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.servePortProxy(w, r, "WS001", 3000, backend.URL, "/")
	}))
	defer proxy.Close()

	header := http.Header{}
	header.Set("Authorization", "Bearer app-token")
	header.Set("Cookie", "vm_session=shared-session; preview_theme=dark")
	connection, response, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(proxy.URL, "http")+"/?token=sam-token&port_token=access-token&channel=app",
		header,
	)
	if err != nil {
		t.Fatalf("preview WebSocket failed to connect: %v", err)
	}
	defer connection.Close()

	_, payload, err := connection.ReadMessage()
	if err != nil {
		t.Fatalf("read preview WebSocket: %v", err)
	}
	if string(payload) != "connected" {
		t.Fatalf("payload = %q, want connected", payload)
	}
	setCookie := response.Header.Get("Set-Cookie")
	if !strings.Contains(setCookie, "preview_socket=active") || strings.Contains(strings.ToLower(setCookie), "domain=") {
		t.Fatalf("application WebSocket cookie was not preserved host-only: %q", setCookie)
	}
}

func TestPrivilegedWebSocketOriginPolicyRejectsWildcardAndPreviewOrigins(t *testing.T) {
	s := &Server{config: &config.Config{AllowedOrigins: []string{
		"*",
		"https://*.example.com",
		"https://app.example.com",
	}}}

	for _, origin := range []string{
		"*",
		"null",
		"https://ws-ws001--3000.example.com",
		"https://evil.example.net",
		"https://app.example.com.evil.test",
	} {
		if s.isOriginAllowed(origin) {
			t.Errorf("untrusted origin %q was allowed", origin)
		}
	}
	if !s.isOriginAllowed("https://app.example.com") {
		t.Fatal("exact app origin was rejected")
	}
}

func TestAgentWSRejectsUntrustedOriginBeforeSessionMutation(t *testing.T) {
	sm := auth.NewSessionManager("vm_session", false, time.Hour)
	defer sm.Stop()
	session, err := sm.CreateSession(&auth.Claims{RegisteredClaims: jwt.RegisteredClaims{Subject: "user-1"}, Workspace: "WS001"})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		config:         &config.Config{AllowedOrigins: []string{"https://app.example.com"}},
		sessionManager: sm,
		agentSessions:  agentsessions.NewManager(),
	}
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/agent/ws?sessionId=session-1", nil)
	req.Header.Set("Origin", "https://ws-ws001--3000.example.com")
	req.Header.Set("Cookie", "vm_session="+session.ID)
	req.Header.Set("X-SAM-Workspace-Id", "WS001")

	s.handleAgentWS(recorder, req)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	if sessions := s.agentSessions.List("WS001"); len(sessions) != 0 {
		t.Fatalf("untrusted origin mutated ACP session state: %#v", sessions)
	}
}

func signPreviewWorkspaceToken(t *testing.T, key *rsa.PrivateKey, workspaceID string) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "test-issuer",
			Subject:   "user-1",
			Audience:  jwt.ClaimStrings{"test-audience"},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
		Workspace: workspaceID,
	})
	token.Header["kid"] = "test-key-1"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}
