package server

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/klauspost/compress/zstd"
	"github.com/workspace/vm-agent/internal/publish"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestBuildContextCollectRouteBothRuntimesLarge(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		instant, shadow, cancel bool
	}{{"VM", false, false, false}, {"Instant", true, false, false}, {"VMShadow", false, true, false}, {"InstantShadow", true, true, false}, {"CancelShadowUpload", false, true, true}} {
		instant, shadow, cancelUpload := tc.instant, tc.shadow, tc.cancel
		t.Run(tc.name, func(t *testing.T) {
			temp := t.TempDir()
			t.Setenv("TMPDIR", temp)
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
			if _, err := rand.New(rand.NewSource(42)).Read(payload); err != nil {
				t.Fatal(err)
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
			var finalEvent publish.Event
			var eventTypes []string
			uploadStarted := make(chan struct{})
			releaseUpload := make(chan struct{})
			requestEnded := make(chan struct{})
			var callbacks *httptest.Server
			callbacks = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				switch {
				case strings.HasSuffix(r.URL.Path, "/events"):
					var event publish.Event
					if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
						t.Error(err)
					}
					eventTypes = append(eventTypes, event.EventType)
					if event.EventType != "publish.job.heartbeat" {
						finalEvent = event
						if !cancelUpload && !completed {
							t.Error("final event preceded verified completion")
						}
					}
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
					<-requestEnded
					if cancelUpload {
						close(uploadStarted)
						<-releaseUpload
						w.WriteHeader(500)
						return
					}
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
			body, _ := json.Marshal(collectBuildContextRequest{McpBuildAndPublishRequest: McpBuildAndPublishRequest{PublishJobID: "job", Attempt: 1, WorkingDir: work}, Shadow: shadow})
			req := httptest.NewRequest("POST", "/workspaces/ws-001/mcp/build-and-publish-jobs/job/collect", bytes.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, s.config.NodeID, "ws-001"))
			req.Header.Set("X-SAM-Node-Id", s.config.NodeID)
			req.Header.Set("X-SAM-Workspace-Id", "ws-001")
			requestCtx, cancelRequest := context.WithCancel(context.Background())
			req = req.WithContext(requestCtx)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			cancelRequest()
			close(requestEnded)
			if rec.Code != http.StatusAccepted {
				t.Fatalf("collect: %d %s", rec.Code, rec.Body.String())
			}
			if cancelUpload {
				select {
				case <-uploadStarted:
				case <-time.After(10 * time.Second):
					t.Fatal("upload did not start")
				}
				cancelRequest := httptest.NewRequest("POST", "/workspaces/ws-001/mcp/build-and-publish-jobs/job/cancel", nil)
				cancelRequest.Header = req.Header.Clone()
				cancelResponse := httptest.NewRecorder()
				mux.ServeHTTP(cancelResponse, cancelRequest)
				close(releaseUpload)
				if cancelResponse.Code != 200 {
					t.Fatalf("cancel: %d %s", cancelResponse.Code, cancelResponse.Body.String())
				}
			}
			expected := "context_ready"
			if shadow {
				expected = "succeeded"
			}
			if cancelUpload {
				expected = "failed"
			}
			deadline := time.Now().Add(10 * time.Second)
			for {
				s.publishJobsMu.Lock()
				state := s.publishJobs["job"]
				s.publishJobsMu.Unlock()
				if !state.CompletedAt.IsZero() {
					if state.Status != expected {
						t.Fatalf("context failed: %s", state.Status)
					}
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("async context collection did not finish")
				}
				time.Sleep(time.Millisecond)
			}
			mu.Lock()
			defer mu.Unlock()
			if finalEvent.Status != expected || finalEvent.Terminal != (shadow || cancelUpload) {
				t.Fatalf("wrong final callback: %+v", finalEvent)
			}
			if len(eventTypes) == 0 || eventTypes[len(eventTypes)-1] == "publish.job.heartbeat" {
				t.Fatal("heartbeat after completion")
			}
			matches, err := filepath.Glob(filepath.Join(temp, "sam-build-context-*"))
			if err != nil || len(matches) != 0 {
				t.Fatalf("archive not cleaned: %v %v", matches, err)
			}
			if cancelUpload {
				if completed {
					t.Fatal("canceled upload completed")
				}
				return
			}
			if len(uploaded) < 1024*1024 {
				t.Fatal("test must exercise a multi-buffer compressed upload")
			}
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
