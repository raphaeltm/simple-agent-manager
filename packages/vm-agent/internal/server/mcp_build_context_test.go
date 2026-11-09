package server

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/klauspost/compress/zstd"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestBuildContextCollectRouteBothRuntimesLarge(t *testing.T) {
	for _, instant := range []bool{false, true} {
		t.Run(map[bool]string{true: "Instant", false: "VM"}[instant], func(t *testing.T) {
			s, key := mcpBuildTestServer(t)
			s.config.ContainerMode = instant
			mount := t.TempDir()
			work := "/workspaces/project"
			root := filepath.Join(mount, "project")
			if instant {
				var err error
				root, err = os.MkdirTemp("/workspaces", "context-test-")
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.RemoveAll(root) })
				work = root
			}
			if err := os.MkdirAll(root, 0700); err != nil {
				t.Fatal(err)
			}
			payload := make([]byte, 3*1024*1024+7)
			for i := range payload {
				payload[i] = byte(i * 31)
			}
			for name, body := range map[string][]byte{"compose.yaml": []byte("services:\n  web:\n    build: .\n    env_file: runtime.env\n"), "Dockerfile": []byte("FROM scratch\nCOPY payload /payload\n"), "payload": payload, "runtime.env": []byte("PASSWORD=never-include-this")} {
				if err := os.WriteFile(filepath.Join(root, name), body, 0600); err != nil {
					t.Fatal(err)
				}
			}
			docker := filepath.Join(t.TempDir(), "docker")
			script := "#!/bin/sh\n"
			if instant {
				script += "exit 99\n"
			} else {
				script += "echo '" + mount + "'\n"
			}
			if err := os.WriteFile(docker, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("SAM_DOCKER_CLI_PATH", docker)
			s.workspaces["ws-001"] = &WorkspaceRuntime{ID: "ws-001", Status: "running", ProjectID: "proj-1", CallbackToken: "callback-token", ContainerWorkDir: work, WorkspaceDir: root}
			var mu sync.Mutex
			var uploaded []byte
			var declared struct {
				Size int64  `json:"sizeBytes"`
				SHA  string `json:"sha256"`
			}
			completed := false
			var callbacks *httptest.Server
			callbacks = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				switch {
				case strings.HasSuffix(r.URL.Path, "/events"):
					io.WriteString(w, "{\"ok\":true}")
				case strings.HasSuffix(r.URL.Path, "/init"):
					if r.Header.Get("Authorization") != "Bearer callback-token" {
						t.Error("missing callback identity")
					}
					if err := json.NewDecoder(r.Body).Decode(&declared); err != nil {
						t.Error(err)
					}
					json.NewEncoder(w).Encode(map[string]string{"uploadUrl": callbacks.URL + "/put"})
				case r.URL.Path == "/put":
					if r.Header.Get("Authorization") != "" {
						t.Error("credential leaked to upload")
					}
					var err error
					uploaded, err = io.ReadAll(r.Body)
					if err != nil {
						t.Error(err)
					}
					if int64(len(uploaded)) != r.ContentLength {
						t.Error("truncated upload")
					}
					if r.Header.Get("x-amz-meta-sha256") != declared.SHA {
						t.Error("digest metadata missing")
					}
					w.WriteHeader(200)
				case strings.HasSuffix(r.URL.Path, "/complete"):
					hash := sha256.Sum256(uploaded)
					if declared.SHA != hex.EncodeToString(hash[:]) || declared.Size != int64(len(uploaded)) {
						t.Error("descriptor mismatch")
					}
					completed = true
					io.WriteString(w, "{\"ok\":true}")
				default:
					t.Errorf("unexpected callback %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer callbacks.Close()
			s.config.ControlPlaneURL = callbacks.URL
			mux := http.NewServeMux()
			s.setupRoutes(mux)
			body, _ := json.Marshal(collectBuildContextRequest{McpBuildAndPublishRequest: McpBuildAndPublishRequest{PublishJobID: "job", Attempt: 1, WorkingDir: work}})
			req := httptest.NewRequest("POST", "/workspaces/ws-001/mcp/build-and-publish-jobs/job/collect", bytes.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, s.config.NodeID, "ws-001"))
			req.Header.Set("X-SAM-Node-Id", s.config.NodeID)
			req.Header.Set("X-SAM-Workspace-Id", "ws-001")
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != 200 {
				t.Fatalf("collect: %d %s", rec.Code, rec.Body.String())
			}
			mu.Lock()
			defer mu.Unlock()
			if !completed {
				t.Fatal("no completion")
			}
			decoder, err := zstd.NewReader(bytes.NewReader(uploaded))
			if err != nil {
				t.Fatal(err)
			}
			defer decoder.Close()
			tr := tar.NewReader(decoder)
			found := false
			for {
				h, err := tr.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				data, _ := io.ReadAll(tr)
				if h.Name == "payload" {
					if !bytes.Equal(data, payload) {
						t.Fatal("large payload truncated")
					}
					found = true
				}
				if bytes.Contains(data, []byte("never-include-this")) {
					t.Fatal("secret leaked")
				}
				if filepath.IsAbs(h.Name) || strings.HasPrefix(h.Name, "../") {
					t.Fatal("tar-slip")
				}
			}
			if !found {
				t.Fatal("large context file missing")
			}
		})
	}
}
