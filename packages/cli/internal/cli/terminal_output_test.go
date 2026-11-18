package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const terminalControlPayload = "before\x00\b\r\x1b]52;c;Y2xpcA==\x07\x1b[2J\u009b31m\u009d0;title\x7fafter"

func assertTerminalControlsEscaped(t *testing.T, output string) {
	t.Helper()
	for _, character := range []rune{'\x00', '\b', '\r', '\x1b', '\x07', '\x7f', '\u009b', '\u009d'} {
		if strings.ContainsRune(output, character) {
			t.Fatalf("output contains terminal control %U: %q", character, output)
		}
	}
	for _, visible := range []string{"\\u0000", "\\u0008", "\\u000D", "\\u001B", "\\u0007", "\\u009B", "\\u009D", "\\u007F"} {
		if !strings.Contains(output, visible) {
			t.Fatalf("output does not contain visible escape %q: %q", visible, output)
		}
	}
}

func TestWriteOutputEscapesTerminalControlsAndPreservesLayout(t *testing.T) {
	var output bytes.Buffer
	text := "ordinary café\tcolumn\n" + terminalControlPayload

	if err := writeOutput(&output, false, text, nil); err != nil {
		t.Fatal(err)
	}

	assertTerminalControlsEscaped(t, output.String())
	if !strings.Contains(output.String(), "ordinary café\tcolumn\n") {
		t.Fatalf("legitimate text layout changed: %q", output.String())
	}
}

func TestSanitizeTerminalLinePreservesOrdinarySpacing(t *testing.T) {
	input := "Project  café\tnext\nline" + terminalControlPayload
	output := sanitizeTerminalLine(input)

	assertTerminalControlsEscaped(t, output)
	if !strings.HasPrefix(output, "Project  café next line") {
		t.Fatalf("single-line text changed ordinary spacing: %q", output)
	}
}

func TestWriteOutputPreservesJSONValues(t *testing.T) {
	var output bytes.Buffer
	value := map[string]string{"content": terminalControlPayload}

	if err := writeOutput(&output, true, "ignored", value); err != nil {
		t.Fatal(err)
	}

	var decoded map[string]string
	if err := json.Unmarshal(output.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["content"] != terminalControlPayload {
		t.Fatalf("JSON content = %q, want %q", decoded["content"], terminalControlPayload)
	}
}

func TestPrintTableEscapesTerminalControlsOnOneRow(t *testing.T) {
	var output strings.Builder
	PrintTable(&output, []string{"ID", "TITLE"}, [][]string{{"1", "ordinary\n" + terminalControlPayload}})

	assertTerminalControlsEscaped(t, output.String())
	if lines := strings.Split(strings.TrimSpace(output.String()), "\n"); len(lines) != 2 {
		t.Fatalf("table contains %d lines, want header and one row: %q", len(lines), output.String())
	}
	if !strings.Contains(output.String(), "ordinary ") {
		t.Fatalf("table lost ordinary cell text: %q", output.String())
	}
}

func TestChatTextEscapesTerminalControls(t *testing.T) {
	env := activeProjectEnv(t)
	response, err := json.Marshal(map[string]any{
		"messages": []map[string]any{{
			"id":        "message_1",
			"role":      "assistant" + terminalControlPayload,
			"content":   "answer\n\t" + terminalControlPayload,
			"createdAt": 1780099200000,
		}},
		"hasMore": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	doer, _ := captureJSONRequest(t, string(response), http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"chat", "session_1"}, doer, env)

	if code := Run(context.Background(), runtime); code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	assertTerminalControlsEscaped(t, stdout.String())
	if !strings.Contains(stdout.String(), "answer\n\t") {
		t.Fatalf("chat layout changed: %q", stdout.String())
	}
}

func TestChatJSONPreservesTerminalControlValues(t *testing.T) {
	env := activeProjectEnv(t)
	response, err := json.Marshal(map[string]any{
		"messages": []map[string]any{{"id": "message_1", "role": "assistant", "content": terminalControlPayload}},
		"hasMore":  false,
	})
	if err != nil {
		t.Fatal(err)
	}
	doer, _ := captureJSONRequest(t, string(response), http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"chat", "session_1", "--json"}, doer, env)

	if code := Run(context.Background(), runtime); code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	var decoded SessionDetailResponse
	if err := json.Unmarshal(stdout.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Messages) != 1 || decoded.Messages[0].Content != terminalControlPayload {
		t.Fatalf("JSON messages = %#v", decoded.Messages)
	}
}

func TestProjectPickerEscapesTerminalControls(t *testing.T) {
	env := tempConfigEnv(t)
	setActiveProjectConfig(t, env, "", "")
	response, err := json.Marshal(map[string]any{
		"projects": []map[string]any{{
			"id":         "01ABCDEFGHIJKLMNOPQRSTUVWX",
			"name":       "project\n" + terminalControlPayload,
			"repository": "repo\t" + terminalControlPayload,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	doer, _ := captureJSONRequest(t, string(response), http.StatusOK)
	runtime, stdout, stderr := testRuntime(t, []string{"project", "use"}, doer, env.values)
	runtime.Stdin = strings.NewReader("1\n")

	if code := Run(context.Background(), runtime); code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	assertTerminalControlsEscaped(t, stdout.String())
	if !strings.Contains(stdout.String(), "project ") || !strings.Contains(stdout.String(), "repo ") {
		t.Fatalf("picker lost single-line project details: %q", stdout.String())
	}
}

func TestTextAPIErrorEscapesTerminalControls(t *testing.T) {
	var stderr bytes.Buffer

	if code := fail(&stderr, APIError{Status: http.StatusBadRequest, Code: "BAD_REQUEST", Message: terminalControlPayload}); code != 1 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	assertTerminalControlsEscaped(t, stderr.String())
}

func TestDeviceLoginEscapesTerminalControls(t *testing.T) {
	env := tempConfigEnv(t)
	requestCount := 0
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		requestCount++
		if requestCount == 1 {
			response, err := json.Marshal(DeviceCodeResponse{
				DeviceCode:              "device_1",
				UserCode:                "CODE\n" + terminalControlPayload,
				VerificationURIComplete: "https://app.example.com/\t" + terminalControlPayload,
				ExpiresIn:               30,
				Interval:                1,
			})
			if err != nil {
				t.Fatal(err)
			}
			return jsonResponse(string(response), http.StatusOK), nil
		}
		return jsonResponse(`{"success":true,"sessionCookie":"cookie","user":{"name":"Dev"}}`, http.StatusOK), nil
	})
	runtime, stdout, stderr := testRuntime(t, []string{"auth", "login", "--api-url", "https://api.example.com"}, doer, env.values)

	if code := Run(context.Background(), runtime); code != 0 {
		t.Fatalf("code = %d stderr=%s", code, stderr.String())
	}
	assertTerminalControlsEscaped(t, stdout.String())
	if !strings.Contains(stdout.String(), "CODE ") || !strings.Contains(stdout.String(), "https://app.example.com/ ") {
		t.Fatalf("device instructions lost legitimate text: %q", stdout.String())
	}
}
