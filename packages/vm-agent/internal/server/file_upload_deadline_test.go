package server

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

// Exercise real socket deadlines: a ResponseRecorder cannot reproduce this bug.
func TestFileUploadSocketDeadline(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		chunked              bool
		delay, uploadTimeout time.Duration
		wantSuccess          bool
	}{
		{"fast_known_length", false, 0, 2 * time.Second, true},
		{"slow_known_length", false, 300 * time.Millisecond, 2 * time.Second, true},
		{"slow_chunked", true, 300 * time.Millisecond, 2 * time.Second, true},
		{"bounded_known_length", false, 400 * time.Millisecond, 150 * time.Millisecond, false},
		{"bounded_chunked", true, 400 * time.Millisecond, 150 * time.Millisecond, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			sm := newMcpTestSessionManager()
			defer sm.Stop()
			s := &Server{config: &config.Config{
				Role: config.RoleStandalone, WorkspaceDir: dir, ContainerWorkDir: dir,
				FileUploadMaxBytes: 1024, FileUploadBatchMaxBytes: 2048, FileUploadTimeout: tc.uploadTimeout,
			}, sessionManager: sm, workspaces: map[string]*WorkspaceRuntime{
				"upload-test": {ID: "upload-test", Status: "running", WorkspaceDir: dir, ContainerWorkDir: dir},
			}}
			mux := http.NewServeMux()
			mux.HandleFunc("POST /workspaces/{workspaceId}/files/upload", s.handleFileUpload)
			server := httptest.NewUnstartedServer(corsMiddleware(mux, nil))
			server.Config.ReadTimeout = 100 * time.Millisecond
			server.Start()
			defer server.Close()

			var body bytes.Buffer
			form := multipart.NewWriter(&body)
			if err := form.WriteField("destination", "."); err != nil {
				t.Fatal(err)
			}
			part, err := form.CreateFormFile("files", "canary.txt")
			if err != nil {
				t.Fatal(err)
			}
			const content = "paced upload canary"
			if _, err := io.WriteString(part, content); err != nil {
				t.Fatal(err)
			}
			if err := form.Close(); err != nil {
				t.Fatal(err)
			}
			payload := body.Bytes()
			reader, writer := io.Pipe()
			defer reader.Close()
			done := make(chan struct{})
			go func() {
				defer close(done)
				defer writer.Close()
				// Stop within the file body, after its headers but before a complete file.
				split := bytes.Index(payload, []byte(content)) + 1
				if _, err := writer.Write(payload[:split]); err != nil {
					return
				}
				time.Sleep(tc.delay)
				_, _ = writer.Write(payload[split:])
			}()
			req, err := http.NewRequest(http.MethodPost, server.URL+"/workspaces/upload-test/files/upload", reader)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", form.FormDataContentType())
			req.AddCookie(injectSession(t, sm, "upload-test"))
			if !tc.chunked {
				req.ContentLength = int64(len(payload))
			}
			client := server.Client()
			client.Timeout = 3 * time.Second
			response, requestErr := client.Do(req)
			var responseBody []byte
			if response != nil {
				responseBody, err = io.ReadAll(response.Body)
				response.Body.Close()
			}
			reader.Close()
			<-done
			stored, fileErr := os.ReadFile(filepath.Join(dir, "canary.txt"))
			if tc.wantSuccess {
				if requestErr != nil {
					t.Fatalf("upload failed: %v", requestErr)
				}
				if err != nil {
					t.Fatalf("read response: %v", err)
				}
				if response.StatusCode != http.StatusOK {
					t.Fatalf("status=%d body=%s", response.StatusCode, responseBody)
				}
				if fileErr != nil || string(stored) != content {
					t.Fatalf("stored=%q error=%v", stored, fileErr)
				}
				if !strings.Contains(string(responseBody), "canary.txt") {
					t.Fatalf("missing upload receipt: %s", responseBody)
				}
			} else {
				if requestErr == nil && response.StatusCode == http.StatusOK {
					t.Fatal("upload exceeded configured deadline but succeeded")
				}
				if !os.IsNotExist(fileErr) {
					t.Fatalf("timed-out upload wrote file: %q error=%v", stored, fileErr)
				}
			}
		})
	}
}
