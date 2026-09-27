package acp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type noopCloser struct{}

func (noopCloser) Close() error { return nil }

func TestCodexNativeClientJSONRPCLifecycle(t *testing.T) {
	t.Parallel()
	serverDone := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		serveCodexNativeTestClient(t, writer, request, serverDone)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &codexNativeClient{conn: conn, transport: noopCloser{}, pending: make(map[int64]chan codexNativeEnvelope), closed: make(chan struct{}), requestTimeout: time.Second}
	go client.readLoop()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.initialize(ctx); err != nil {
		t.Fatal(err)
	}
	if err := client.resumeThread(ctx, "thread-1"); err != nil {
		t.Fatal(err)
	}
	thread, err := client.readThread(ctx, "thread-1")
	if err != nil || !strings.Contains(string(thread.Thread), `"id":"thread-1"`) || thread.Sequence == 0 {
		t.Fatalf("thread/read = %#v, %v", thread, err)
	}
	if err := client.interruptTurn(ctx, "thread-1", "turn-1"); err != nil {
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-serverDone:
	case <-time.After(time.Second):
		t.Fatal("server did not observe client close")
	}
}

func serveCodexNativeTestClient(t *testing.T, writer http.ResponseWriter, request *http.Request, done chan<- struct{}) {
	t.Helper()
	conn, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(writer, request, nil)
	if err != nil {
		t.Errorf("upgrade: %v", err)
		return
	}
	defer conn.Close()
	defer close(done)
	for {
		var message map[string]json.RawMessage
		if err := conn.ReadJSON(&message); err != nil {
			return
		}
		if !writeCodexNativeTestResponse(t, conn, message) {
			return
		}
	}
}

func writeCodexNativeTestResponse(t *testing.T, conn *websocket.Conn, message map[string]json.RawMessage) bool {
	t.Helper()
	var method string
	_ = json.Unmarshal(message["method"], &method)
	if method == "initialized" {
		return true
	}
	result, known := codexNativeTestResult(method)
	if !known {
		t.Errorf("unexpected method %q", method)
	}
	if err := conn.WriteJSON(map[string]any{"id": message["id"], "result": result}); err != nil {
		t.Errorf("write: %v", err)
		return false
	}
	return true
}

func codexNativeTestResult(method string) (any, bool) {
	switch method {
	case "initialize":
		return map[string]any{"userAgent": "codex-cli " + codexSharedDaemonVersion, "codexHome": "/test", "platformFamily": "unix", "platformOs": "linux"}, true
	case "thread/resume":
		return map[string]any{"thread": map[string]any{"id": "thread-1"}}, true
	case "thread/read":
		return map[string]any{"thread": map[string]any{"id": "thread-1", "turns": []any{}}}, true
	case "turn/interrupt":
		return map[string]any{}, true
	default:
		return map[string]any{}, false
	}
}

func TestCodexNativeProxyEnvironmentIsMinimal(t *testing.T) {
	t.Parallel()
	got := proxyEnvironment([]string{"HOME=/home/sam", "CODEX_HOME=/home/sam/.codex", "SECRET=do-not-forward", "XDG_RUNTIME_DIR=/run/user/1"})
	joined := strings.Join(got, "\n")
	if strings.Contains(joined, "SECRET") || !strings.Contains(joined, "CODEX_HOME=") {
		t.Fatalf("proxy environment = %q", joined)
	}
}

func TestCodexServerIdentityRequiresExactVersionToken(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		identity string
		want     bool
	}{
		{identity: "codex_cli_rs/0.156.1 (linux)", want: true},
		{identity: "codex-cli 0.156.1", want: true},
		{identity: "codex_cli_rs/0.156.10 (linux)", want: false},
		{identity: "codex_cli_rs/0.156.1-dev (linux)", want: false},
		{identity: "forged-0.156.1", want: false},
	} {
		if got := hasExactVersionToken(test.identity, codexSharedDaemonVersion); got != test.want {
			t.Errorf("hasExactVersionToken(%q)=%t, want %t", test.identity, got, test.want)
		}
	}
}
