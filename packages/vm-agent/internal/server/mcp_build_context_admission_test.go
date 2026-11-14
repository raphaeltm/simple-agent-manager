package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBuildContextCollectionAdmission(t *testing.T) {
	for _, tc := range []struct {
		name   string
		active []publishJobState
		want   int
		limit  int
	}{
		{"same workspace active", []publishJobState{{ID: "first", ContextOnly: true, WorkspaceID: "ws"}}, http.StatusConflict, 0},
		{"duplicate job", []publishJobState{{ID: "next", ContextOnly: true, WorkspaceID: "ws"}}, http.StatusConflict, 0},
		{"finished collection", []publishJobState{{ID: "first", ContextOnly: true, WorkspaceID: "ws", CompletedAt: time.Now()}}, http.StatusAccepted, 0},
		{"other workspace", []publishJobState{{ID: "first", ContextOnly: true, WorkspaceID: "other"}}, http.StatusAccepted, 0},
		{"node build", []publishJobState{{ID: "first", WorkspaceID: "ws"}}, http.StatusAccepted, 0},
		{"configured capacity allows second", []publishJobState{{ID: "first", ContextOnly: true, WorkspaceID: "ws"}}, http.StatusAccepted, 2},
		{"configured capacity rejects third", []publishJobState{{ID: "first", ContextOnly: true, WorkspaceID: "ws"}, {ID: "second", ContextOnly: true, WorkspaceID: "ws"}}, http.StatusConflict, 2},
		{"negative cannot disable bound", []publishJobState{{ID: "first", ContextOnly: true, WorkspaceID: "ws"}}, http.StatusConflict, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, key := mcpBuildTestServer(t)
			s.config.BuildContextMaxActivePerWorkspace = tc.limit
			callbacks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{}`)) }))
			defer callbacks.Close()
			s.config.ControlPlaneURL = callbacks.URL
			s.workspaces["ws"] = &WorkspaceRuntime{ID: "ws", ProjectID: "proj", CallbackToken: "callback", Status: "running"}
			s.publishJobs = map[string]publishJobState{}
			for _, state := range tc.active {
				s.publishJobs[state.ID] = state
			}
			body, _ := json.Marshal(collectBuildContextRequest{McpBuildAndPublishRequest: McpBuildAndPublishRequest{PublishJobID: "next", Attempt: 1, WorkingDir: "/outside"}})
			req := httptest.NewRequest(http.MethodPost, "/workspaces/ws/mcp/build-and-publish-jobs/next/collect", bytes.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, s.config.NodeID, "ws"))
			req.Header.Set("X-SAM-Node-Id", s.config.NodeID)
			req.Header.Set("X-SAM-Workspace-Id", "ws")
			mux := http.NewServeMux()
			s.setupRoutes(mux)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("status=%d want=%d body=%s", rec.Code, tc.want, rec.Body.String())
			}
			// Accepted owner controls deliberately fail source validation immediately;
			// wait for their terminal callback before tearing down the HTTP server.
			if rec.Code == http.StatusAccepted {
				deadline := time.Now().Add(5 * time.Second)
				for {
					s.publishJobsMu.Lock()
					finished := !s.publishJobs["next"].CompletedAt.IsZero()
					s.publishJobsMu.Unlock()
					if finished {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("collection did not finish")
					}
					time.Sleep(time.Millisecond)
				}
			}
		})
	}
}
