package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/websocket"
)

func TestPortProxyCredentials(t *testing.T) {
	h := newRelayHarness(t)
	h.server.config.CookieName = "__Secure-custom_agent_session"
	for _, authorization := range []string{"", "Basic YXBwOnBhc3M=", "Bearer application-token", "Bearer " + h.portProxyToken(), "bEaReR " + h.portProxyToken()} {
		t.Run("authorization boundary", func(t *testing.T) {
			received := make(chan *http.Request, 1)
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				received <- r.Clone(r.Context())
				w.WriteHeader(http.StatusOK)
			}))
			defer backend.Close()
			req := httptest.NewRequest("GET", backend.URL+"/echo?token=agent-token&keep=yes", nil)
			req.Header.Set("Cookie", "sam_port_access=preview; vm_session=legacy; vm_session_ws=scoped; __Secure-custom_agent_session=custom; __Secure-custom_agent_session_ws=scoped; __Secure-better-auth.session_token=login; __Host-better-auth.session_data=data; app_session=app; theme=dark")
			req.Header.Set("Authorization", authorization)
			rr := httptest.NewRecorder()
			h.server.servePortProxy(rr, req, relayTestWorkspaceID, 3000, backend.URL, "/echo")
			if rr.Code != http.StatusOK {
				t.Fatalf("unexpected status %d", rr.Code)
			}
			got := <-received
			if got.Header.Get("Cookie") != "app_session=app; theme=dark" {
				t.Fatal("incorrect application cookie filtering")
			}
			wantAuthorization := authorization
			if authorization != "" && authorization != "Basic YXBwOnBhc3M=" && authorization != "Bearer application-token" {
				wantAuthorization = ""
			}
			if got.Header.Get("Authorization") != wantAuthorization {
				t.Fatal("incorrect application authorization filtering")
			}
			if got.URL.Query().Get("token") != "" || got.URL.Query().Get("keep") != "yes" {
				t.Fatal("incorrect query credential filtering")
			}
			if req.Header.Get("Cookie") == got.Header.Get("Cookie") {
				t.Fatal("incoming request must not be mutated")
			}
		})
	}
}

func TestPortProxyWebSocketCredentials(t *testing.T) {
	h := newRelayHarness(t)
	received := make(chan *http.Request, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Clone(r.Context())
		conn, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteMessage(websocket.TextMessage, []byte("ready"))
	}))
	defer backend.Close()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.server.servePortProxy(w, r, relayTestWorkspaceID, 3000, backend.URL, "/ws")
	}))
	defer proxy.Close()
	headers := http.Header{}
	headers.Set("Cookie", "sam_port_access=preview; vm_session_ws=scoped; app_session=app")
	headers.Set("Authorization", "Bearer "+h.portProxyToken())
	conn, response, err := websocket.DefaultDialer.Dial("ws"+proxy.URL[4:]+"/ws?token=agent-token", headers)
	if err != nil {
		if response != nil {
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
		}
		t.Fatal("websocket upgrade failed")
	}
	defer conn.Close()
	_, data, err := conn.ReadMessage()
	if err != nil || string(data) != "ready" {
		t.Fatal("websocket frame failed")
	}
	got := <-received
	if got.Header.Get("Cookie") != "app_session=app" || got.Header.Get("Authorization") != "" || got.URL.Query().Get("token") != "" {
		t.Fatal("websocket leaked SAM credentials")
	}
}
