package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
)

func TestLocalForwardProxyPreservesAppHeadersAndLocalhostAuthority(t *testing.T) {
	t.Parallel()

	var gotHost string
	var gotAuthorization string
	var gotCookie string
	var gotSAMHeader string
	var gotForwarded string
	var gotForwardedFor string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		gotAuthorization = r.Header.Get("Authorization")
		gotCookie = r.Header.Get("Cookie")
		gotSAMHeader = r.Header.Get("X-SAM-VM-Forward-Token")
		gotForwarded = r.Header.Get("Forwarded")
		gotForwardedFor = r.Header.Get("X-Forwarded-For")
		w.Header().Add("Set-Cookie", "app_one=1; Path=/")
		w.Header().Add("Set-Cookie", "app_two=2; Path=/")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "ok")
	}))
	defer backend.Close()

	s := &Server{config: &config.Config{ControlPlaneURL: "https://api.example.com"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, backend.URL+"/ignored", nil)
	req.Header.Set("Authorization", "Bearer app-token")
	req.Header.Set("Cookie", "app_session=abc")
	req.Header.Set("X-SAM-VM-Forward-Token", "must-strip")
	req.Header.Set("Forwarded", "for=evil")
	req.Header.Set("X-Forwarded-Host", "evil.example.com")

	s.serveLocalForwardProxy(rr, req, backend.URL, "/app", "localhost:5173")

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rr.Code, rr.Body.String())
	}
	if gotHost != "localhost:5173" {
		t.Fatalf("Host = %q, want localhost authority", gotHost)
	}
	if gotAuthorization != "Bearer app-token" {
		t.Fatalf("Authorization = %q, want app token preserved", gotAuthorization)
	}
	if gotCookie != "app_session=abc" {
		t.Fatalf("Cookie = %q, want app cookie preserved", gotCookie)
	}
	if gotSAMHeader != "" {
		t.Fatalf("X-SAM header reached app: %q", gotSAMHeader)
	}
	if gotForwarded != "" {
		t.Fatalf("Forwarded header reached app: %q", gotForwarded)
	}
	if gotForwardedFor != "127.0.0.1" {
		t.Fatalf("X-Forwarded-For = %q, want loopback", gotForwardedFor)
	}
	if got := rr.Result().Header.Values("Set-Cookie"); len(got) != 2 {
		t.Fatalf("Set-Cookie headers = %v, want both app cookies preserved", got)
	}
	if rr.Result().Header.Get("Set-Cookie") == "sam_port_access" {
		t.Fatal("local-forward must not set SAM session cookies")
	}
}

func TestLocalForwardEscapedPathPreservesEncodedSegments(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "https://node.example.com/workspaces/ws-1/local-forward/5173/a%2Fb/c?x=a%2Fb", nil)

	if got := localForwardEscapedPath(req, "ws-1", "5173"); got != "/a%2Fb/c" {
		t.Fatalf("escaped forward path = %q, want /a%%2Fb/c", got)
	}
}

func TestLocalForwardProxyPreservesEscapedPathSegments(t *testing.T) {
	t.Parallel()

	requestURIs := make(chan string, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestURIs <- r.RequestURI
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	s := &Server{config: &config.Config{ControlPlaneURL: "https://api.example.com"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://node.example.com/workspaces/ws-1/local-forward/5173/ignored?x=a%2Fb", nil)

	s.serveLocalForwardProxy(rr, req, backend.URL, "/app/a%2Fb/c", "localhost:5173")

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rr.Code, rr.Body.String())
	}

	select {
	case got := <-requestURIs:
		want := "/app/a%2Fb/c?x=a%2Fb"
		if got != want {
			t.Fatalf("backend RequestURI = %q, want %q", got, want)
		}
	default:
		t.Fatal("backend did not receive proxied request")
	}
}

func TestResolveWorkspaceBridgeIPUsesHostLoopbackOnlyOutsideContainerMode(t *testing.T) {
	t.Parallel()

	s := &Server{config: &config.Config{ContainerMode: false}}

	got, err := s.resolveWorkspaceBridgeIP("ws-1")
	if err != nil {
		t.Fatalf("resolveWorkspaceBridgeIP returned error: %v", err)
	}
	if got != "127.0.0.1" {
		t.Fatalf("resolveWorkspaceBridgeIP = %q, want host loopback", got)
	}
}

func TestResolveWorkspaceBridgeIPRejectsContainerModeFallback(t *testing.T) {
	t.Parallel()

	s := &Server{
		config: &config.Config{ContainerMode: true},
		containerDiscovery: container.NewDiscovery(container.Config{
			LabelKey:   "devcontainer.local_folder",
			LabelValue: "/workspace/global",
		}),
		portDiscoveries: map[string]*container.Discovery{},
		workspaces:      map[string]*WorkspaceRuntime{},
	}

	got, err := s.resolveWorkspaceBridgeIP("ws-1")
	if err == nil {
		t.Fatalf("resolveWorkspaceBridgeIP = %q, want missing workspace route error", got)
	}
	if !strings.Contains(err.Error(), "workspace container route is not registered") {
		t.Fatalf("resolveWorkspaceBridgeIP error = %q, want workspace route error", err)
	}
}

func TestStripLocalForwardRequestHeadersRemovesConnectionListedHeaders(t *testing.T) {
	t.Parallel()

	headers := http.Header{}
	headers.Set("Authorization", "Bearer app-token")
	headers.Set("Cookie", "app_session=abc")
	headers.Set("Connection", "X-App-Hop, X-Forwarded-For")
	headers.Set("X-App-Hop", "must-strip")
	headers.Set("X-Forwarded-For", "spoofed")
	headers.Set("X-SAM-VM-Forward-Token", "must-strip")

	stripLocalForwardRequestHeaders(headers)

	if got := headers.Get("Authorization"); got != "Bearer app-token" {
		t.Fatalf("Authorization = %q, want app token preserved", got)
	}
	if got := headers.Get("Cookie"); got != "app_session=abc" {
		t.Fatalf("Cookie = %q, want app cookie preserved", got)
	}
	for _, name := range []string{"Connection", "X-App-Hop", "X-Forwarded-For", "X-SAM-VM-Forward-Token"} {
		if got := headers.Get(name); got != "" {
			t.Fatalf("%s reached stripped headers: %q", name, got)
		}
	}
}
