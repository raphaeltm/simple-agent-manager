package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Enumerate the terminal control classes independently of the encoder. A positive
// content assertion in each scenario ensures an empty/crashed command cannot pass.
func requireInertTerminal(t *testing.T, output string) {
	t.Helper()
	for _, r := range output {
		if r < 32 && r != '\n' && r != '\t' || r >= 127 && r <= 159 {
			t.Fatalf("active terminal control %U in output %q", r, output)
		}
	}
}

func allTerminalControls() string {
	var s strings.Builder
	for r := rune(0); r < 160; r++ {
		if r < 32 && r != '\n' && r != '\t' || r >= 127 {
			s.WriteRune(r)
		}
	}
	return s.String() + "\x1b]52;c;Y2xpcA==\x07\x1b]0;title\x1b\\\x1b[2J"
}

func TestTerminalBoundaryCommandScenarios(t *testing.T) {
	payload := "café  世界\n\tanswer" + allTerminalControls()
	for _, scenario := range []terminalScenario{
		{"chat text", []string{"chat", "session_1"}, map[string]any{"messages": []any{map[string]any{"id": "m1", "role": "assistant", "content": payload}}, "hasMore": false}, 200, false},
		{"chat JSON", []string{"chat", "session_1", "--json"}, map[string]any{"messages": []any{map[string]any{"id": "m1", "role": "assistant", "content": payload}}, "hasMore": false}, 200, false},
		{"ports table", []string{"workspace", "ws1", "ports"}, map[string]any{"ports": []any{map[string]any{"port": 3000, "label": payload, "url": payload}}}, 200, false},
		{"ports JSON", []string{"workspace", "ws1", "ports", "--json"}, map[string]any{"ports": []any{map[string]any{"port": 3000, "label": payload, "url": payload}}}, 200, false},
		{"API error text", []string{"workspace", "ws1", "ports"}, map[string]any{"error": "BAD_REQUEST", "message": payload}, 400, true},
		{"API error JSON", []string{"workspace", "ws1", "ports", "--json"}, map[string]any{"error": "BAD_REQUEST", "message": payload}, 400, true},
		{"help", []string{payload, "--help"}, nil, 200, false},
		{"unknown command", []string{payload}, nil, 200, true},
		{"unknown command JSON", []string{payload, "--json"}, nil, 200, true},
	} {
		t.Run(scenario.name, func(t *testing.T) { runTerminalScenario(t, scenario, payload) })
	}
}

type terminalScenario struct {
	name        string
	args        []string
	response    any
	status      int
	errorOutput bool
}

func runTerminalScenario(t *testing.T, scenario terminalScenario, payload string) {
	t.Helper()
	encoded, err := json.Marshal(scenario.response)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		return jsonResponse(string(encoded), scenario.status), nil
	})
	runtime, stdout, stderr := testRuntime(t, scenario.args, doer, activeProjectEnv(t))
	code := Run(context.Background(), runtime)
	if scenario.errorOutput != (code != 0) {
		t.Fatalf("exit=%d stderr=%q", code, stderr.String())
	}
	output := stdout.String()
	if scenario.errorOutput {
		output = stderr.String()
	}
	requireInertTerminal(t, output)
	if scenario.response != nil && scenario.errorOutput {
		if !strings.Contains(output, "SAM API request failed with 400") || strings.Contains(output, "café") {
			t.Fatalf("API error disclosure changed: %q", output)
		}
	} else if !strings.Contains(output, "café") {
		t.Fatalf("missing legitimate content: %q", output)
	}
	if strings.Contains(scenario.name, "JSON") {
		requireTerminalJSON(t, scenario, payload, output)
	}
	if scenario.name == "chat text" && !strings.Contains(output, "café  世界\n\tanswer") {
		t.Fatalf("chat layout changed: %q", output)
	}
	if scenario.response != nil && calls != 1 {
		t.Fatalf("HTTP calls=%d want1", calls)
	}
}

func requireTerminalJSON(t *testing.T, scenario terminalScenario, payload, output string) {
	t.Helper()
	var decoded any
	if err := json.Unmarshal([]byte(output), &decoded); err != nil {
		t.Fatal(err)
	}
	// Full value equality checks controls, Unicode, spacing and multiline layout.
	want := scenario.response
	if scenario.response == nil {
		want = map[string]any{"error": "CLI_ERROR", "message": "unknown command: " + payload + "\nRun `sam --help` for usage"}
	}
	if scenario.errorOutput && scenario.response != nil {
		want = map[string]any{"error": "BAD_REQUEST", "message": "failed to list ports: BAD_REQUEST: SAM API request failed with 400; use the error code to reconcile or correct the request", "status": 400}
	}
	wantBytes, _ := json.Marshal(want)
	gotBytes, _ := json.Marshal(decoded)
	if !bytes.Equal(wantBytes, gotBytes) {
		t.Fatalf("JSON semantic change: %s != %s", gotBytes, wantBytes)
	}
}

func TestTerminalBoundaryTranscriptJSONAndNDJSON(t *testing.T) {
	payload := "café  世界\n\t" + allTerminalControls()
	for _, ndjson := range []bool{false, true} {
		t.Run(fmt.Sprint(ndjson), func(t *testing.T) { runTerminalTranscriptScenario(t, ndjson, payload) })
	}
}

func runTerminalTranscriptScenario(t *testing.T, ndjson bool, payload string) {
	t.Helper()
	row := map[string]any{"id": "m1", "role": "assistant", "content": payload, "sequence": 1, "createdAt": 123}
	encoded, _ := json.Marshal(map[string]any{"messages": []any{row}, "hasMore": false})
	doer, captured := captureJSONRequest(t, string(encoded), 200)
	args := []string{"chat", "export", "session_1"}
	if ndjson {
		args = append(args, "--ndjson")
	}
	runtime, stdout, stderr := testRuntime(t, args, doer, activeProjectEnv(t))
	if code := Run(context.Background(), runtime); code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr.String())
	}
	requireInertTerminal(t, stdout.String())
	var result map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	message := result
	if !ndjson {
		message = result["messages"].([]any)[0].(map[string]any)
	}
	if message["content"] != payload {
		t.Fatalf("export changed payload: %q", message["content"])
	}
	if !strings.Contains(captured.URL, "/sessions/session_1/messages?") {
		t.Fatalf("wrong API trigger: %s", captured.URL)
	}
}

// Drive the same listener handler used by `workspace forward` with a real HTTP
// request. The decoded path is hostile; remote request and streamed response must
// remain exact while the diagnostic bytes are safe.
func TestTerminalBoundaryForwardedPathAndResponse(t *testing.T) {
	payload := "café  世界\n\t" + allTerminalControls()
	remotePaths := make(chan string, 1)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		remotePaths <- r.URL.Path
		for _, chunk := range []string{payload[:8], payload[8:]} {
			_, _ = io.WriteString(w, chunk)
			w.(http.Flusher).Flush()
		}
	}))
	defer remote.Close()
	doer, _ := captureJSONRequest(t, `{"token":"fake-forward-token","expiresAt":"2099-01-01T00:00:00Z"}`, 200)
	client := NewAPIClient(CLIConfig{APIURL: remote.URL, SessionCookie: "fake-cookie"}, doer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	var stderr bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		acceptConnections(ctx, Runtime{Stderr: &stderr}, client, acceptConnectionsConfig{workspaceID: "ws1", remotePort: 3000, localPort: port, localHost: "127.0.0.1", listener: listener, remoteURL: remote.URL})
	}()
	localClient := &http.Client{Timeout: 5 * time.Second}
	path := "/" + payload
	res, err := localClient.Get(fmt.Sprintf("http://127.0.0.1:%d", port) + "/" + url.PathEscape(path))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("proxy shutdown timeout")
	}
	if res.StatusCode != 200 || string(body) != payload {
		t.Fatalf("transport changed: status=%d body=%q", res.StatusCode, body)
	}
	if got := <-remotePaths; got != "/"+path {
		t.Fatalf("forwarded path=%q want=%q", got, "/"+path)
	}
	requireInertTerminal(t, stderr.String())
	if !strings.Contains(stderr.String(), "café  世界") || !strings.Contains(stderr.String(), "localhost:3000") {
		t.Fatalf("missing diagnostic: %q", stderr.String())
	}
}

func TestTerminalBoundaryDeviceJSONDiagnostic(t *testing.T) {
	payload := "café  世界" + allTerminalControls()
	calls := 0
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			b, _ := json.Marshal(DeviceCodeResponse{DeviceCode: "device_1", UserCode: payload, VerificationURIComplete: "https://app.example.com/" + payload, ExpiresIn: 30, Interval: 1})
			return jsonResponse(string(b), 200), nil
		}
		return jsonResponse(`{"success":true,"sessionCookie":"fake-cookie","user":{"name":"Dev"}}`, 200), nil
	})
	env := tempConfigEnv(t)
	runtime, stdout, stderr := testRuntime(t, []string{"auth", "login", "--api-url", "https://api.example.com", "--json"}, doer, env.values)
	if code := Run(context.Background(), runtime); code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr.String())
	}
	requireInertTerminal(t, stdout.String())
	requireInertTerminal(t, stderr.String())
	var diagnostic map[string]any
	if err := json.Unmarshal(stderr.Bytes(), &diagnostic); err != nil {
		t.Fatal(err)
	}
	if diagnostic["userCode"] != payload || diagnostic["verificationUrl"] != "https://app.example.com/"+payload {
		t.Fatalf("device diagnostic changed: %#v", diagnostic)
	}
	if calls != 2 {
		t.Fatalf("calls=%d want2", calls)
	}
}
