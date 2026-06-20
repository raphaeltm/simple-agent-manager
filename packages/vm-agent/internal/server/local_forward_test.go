package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func TestLocalForwardProxyPreservesAppHeadersAndLocalhostAuthority(t *testing.T) {
	t.Parallel()

	var gotHost string
	var gotAuthorization string
	var gotCookie string
	var gotSAMHeader string
	var gotForwarded string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		gotAuthorization = r.Header.Get("Authorization")
		gotCookie = r.Header.Get("Cookie")
		gotSAMHeader = r.Header.Get("X-SAM-VM-Forward-Token")
		gotForwarded = r.Header.Get("Forwarded")
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
	if got := rr.Result().Header.Values("Set-Cookie"); len(got) != 2 {
		t.Fatalf("Set-Cookie headers = %v, want both app cookies preserved", got)
	}
	if got := rr.Result().Header.Get("Set-Cookie"); got == "sam_port_access" {
		t.Fatal("local-forward must not set SAM session cookies")
	}
}
