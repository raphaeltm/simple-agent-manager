package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/publish"
)

func TestMcpBuildAndPublishHeartbeatsDuringSilentRunner(t *testing.T) {
	for _, blocked := range []bool{false, true} {
		t.Run(map[bool]string{false: "periodic", true: "blocked callback canceled before terminal"}[blocked], func(t *testing.T) {
			s, key := mcpBuildTestServer(t)
			t.Setenv("SAM_DOCKER_CLI_PATH", fakeDockerCLI(t, t.TempDir(), "", true))
			s.config.DeployPublishHeartbeatInterval = 5 * time.Millisecond
			s.config.HTTPCallbackTimeout = 5 * time.Second
			events := make(chan publish.Event, 64)
			callbacks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var event publish.Event
				if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
					t.Error(err)
					return
				}
				events <- event
				if blocked && event.EventType == "publish.job.heartbeat" {
					<-r.Context().Done()
					return
				}
				w.WriteHeader(http.StatusOK)
			}))
			defer callbacks.Close()
			s.config.ControlPlaneURL = callbacks.URL
			s.workspaces["ws-001"] = &WorkspaceRuntime{ID: "ws-001", Status: "running", WorkspaceDir: "/workspace/WS_001", ProjectID: "proj-1", CallbackToken: "callback-token"}
			release := make(chan struct{})
			var once sync.Once
			finish := func() { once.Do(func() { close(release) }) }
			defer finish()
			s.buildPublishRunner = func(ctx context.Context, _ *preparedBuildPublish, _ publish.EventSink) (*publish.ReleaseResult, error) {
				select {
				case <-release:
					return &publish.ReleaseResult{ReleaseID: "release", Version: 1}, nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			rec := mcpBuildJobStartPOST(t, s, key, "ws-001", "job-heartbeat", McpBuildAndPublishRequest{PublishJobID: "job-heartbeat", Environment: "staging", EnvironmentID: "env-1"}, context.Background())
			if rec.Code != http.StatusAccepted {
				t.Fatalf("start status = %d: %s", rec.Code, rec.Body.String())
			}
			want := 2
			if blocked {
				want = 1
			}
			deadline := time.After(time.Second)
			for count := 0; count < want; {
				select {
				case event := <-events:
					if event.Terminal {
						t.Fatal("silent runner ended before release")
					}
					if event.EventType == "publish.job.heartbeat" {
						count++
						if event.Status != "" || event.CurrentStep != "" {
							t.Fatalf("heartbeat changes progress: %+v", event)
						}
					}
				case <-deadline:
					t.Fatal("silent build did not heartbeat")
				}
			}
			finish()
			terminal := false
			deadline = time.After(time.Second)
			for !terminal {
				select {
				case event := <-events:
					terminal = event.Terminal
				case <-deadline:
					t.Fatal("completion did not abort heartbeat callback promptly")
				}
			}
			select {
			case event := <-events:
				t.Fatalf("callback after terminal: %+v", event)
			case <-time.After(25 * time.Millisecond):
			}
		})
	}
}
