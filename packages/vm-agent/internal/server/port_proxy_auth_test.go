package server

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Exercise the real mux: the Worker supplies a SAM query JWT alongside app auth.
func TestPortProxyHandlerSeparatesApplicationBearer(t *testing.T) {
	for _, upgrade := range []bool{false, true} {
		name := "HTTP"
		if upgrade {
			name = "WebSocket"
		}
		t.Run(name, func(t *testing.T) {
			h := newRelayHarness(t)
			var calls atomic.Int32
			received := make(chan *http.Request, 1)
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				received <- r.Clone(r.Context())
				if upgrade {
					conn, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
					if err != nil {
						return
					}
					defer conn.Close()
					_ = conn.WriteMessage(websocket.TextMessage, []byte("ready"))
				} else {
					w.WriteHeader(http.StatusOK)
				}
			}))
			defer backend.Close()
			port := backend.Listener.Addr().(*net.TCPAddr).Port
			req := h.apiPortRequest(port, "/echo", "keep=yes", true)
			req.Header.Set("Authorization", "Bearer application-token")
			req.Header.Set("Cookie", "sam_port_access=preview; app_session=app")
			if upgrade {
				conn, response, err := (&websocket.Dialer{HandshakeTimeout: 5 * time.Second}).Dial("ws"+strings.TrimPrefix(req.URL.String(), "http"), req.Header)
				if err != nil {
					if response != nil {
						response.Body.Close()
						t.Fatalf("upgrade status %d", response.StatusCode)
					}
					t.Fatal("upgrade failed")
				}
				defer conn.Close()
				_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
				_, data, err := conn.ReadMessage()
				if err != nil || string(data) != "ready" {
					t.Fatal("upgrade frame failed")
				}
			} else {
				response, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
				if err != nil {
					t.Fatal("HTTP request failed")
				}
				_, _ = io.Copy(io.Discard, response.Body)
				response.Body.Close()
				if response.StatusCode != http.StatusOK {
					t.Fatalf("HTTP status %d", response.StatusCode)
				}
			}
			got := <-received
			if got.Header.Get("Authorization") != "Bearer application-token" || got.Header.Get("Cookie") != "app_session=app" || got.URL.Query().Get("token") != "" || got.URL.Query().Get("keep") != "yes" {
				t.Fatal("application auth or credential isolation failed")
			}

			query := req.URL.Query()
			query.Set("token", "invalid-sam-token")
			req.URL.RawQuery = query.Encode()
			response, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
			if err != nil {
				t.Fatal("invalid-token request failed")
			}
			response.Body.Close()
			if response.StatusCode != http.StatusUnauthorized || calls.Load() != 1 {
				t.Fatal("invalid SAM credential reached application")
			}
		})
	}
}
