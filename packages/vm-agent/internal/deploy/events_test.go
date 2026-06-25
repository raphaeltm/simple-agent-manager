package deploy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReportApplyEventPostsReleaseScopedEventWithoutSignedArtifactURL(t *testing.T) {
	var gotPath string
	var gotAuth string
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode event body: %v", err)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	engine := NewEngine(nil, nil, EngineConfig{
		EnvironmentID:   "env-1",
		NodeID:          "node-1",
		ControlPlaneURL: server.URL,
		CallbackToken:   "node-token",
		HTTPClient:      server.Client(),
	})
	payload := &ApplyPayload{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Seq:           7,
		Artifacts: []ImageArtifact{{
			ServiceName: "web",
			R2Key:       "compose-image-artifacts/proj/env/ws/upload/web.tar",
			DownloadURL: "https://r2.example/web.tar?X-Amz-Signature=secret",
		}},
	}

	engine.reportApplyEvent(context.Background(), payload, "info", "deployment.apply.artifacts_load_started", "load_artifacts", "loading artifacts", map[string]any{
		"artifactCount": len(payload.Artifacts),
	})

	if gotPath != "/api/nodes/node-1/deployment-release-events" {
		t.Fatalf("unexpected callback path %q", gotPath)
	}
	if gotAuth != "Bearer node-token" {
		t.Fatalf("unexpected auth header %q", gotAuth)
	}
	raw, _ := json.Marshal(got)
	if strings.Contains(string(raw), "X-Amz-Signature") || strings.Contains(string(raw), "secret") {
		t.Fatalf("event leaked signed artifact URL: %s", string(raw))
	}
	if got["environmentId"] != "env-1" || got["releaseVersion"] != float64(7) {
		t.Fatalf("unexpected event identity: %#v", got)
	}
}
