package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func TestServerRefusesTokenBearingMuxRedirect(t *testing.T) {
	for _, suffix := range []string{"//app", "/./app", "/x/../app"} {
		t.Run(suffix, func(t *testing.T) {
			s := &Server{config: &config.Config{}}
			mux := http.NewServeMux()
			calls := 0
			mux.HandleFunc("/workspaces/{workspaceId}/ports/{port}/{path...}", func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(200) })
			s.buildHTTPServers(mux)
			request := httptest.NewRequest("GET", "http://agent/workspaces/ws/ports/3000"+suffix+"?token=secret-jwt&keep=yes", nil)
			response := httptest.NewRecorder()
			s.httpServer.Handler.ServeHTTP(response, request)
			if response.Code != 400 || response.Header().Get("Location") != "" || strings.Contains(response.Body.String(), "secret-jwt") || calls != 0 {
				t.Fatal("noncanonical request was not refused before token-bearing redirect")
			}
		})
	}
}

func TestServerTokenRedirectGuardControls(t *testing.T) {
	for _, suffix := range []string{"/app", "/app/", "/%2e/app", "/%2f/app"} {
		t.Run(suffix, func(t *testing.T) {
			s := &Server{config: &config.Config{}}
			mux := http.NewServeMux()
			mux.HandleFunc("/workspaces/{workspaceId}/ports/{port}/{path...}", func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("token") != "secret-jwt" {
					t.Fatal("authentication input changed")
				}
				http.Redirect(w, r, "/login", http.StatusTemporaryRedirect)
			})
			s.buildHTTPServers(mux)
			request := httptest.NewRequest("GET", "http://agent/workspaces/ws/ports/3000"+suffix+"?token=secret-jwt", nil)
			response := httptest.NewRecorder()
			s.httpServer.Handler.ServeHTTP(response, request)
			if response.Code != 307 || response.Header().Get("Location") != "/login" {
				t.Fatal("application redirect changed")
			}
		})
	}
}
