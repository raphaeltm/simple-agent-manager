package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/workspace/vm-agent/internal/publish"
)

// publishCallbackToken reads the workspace token for each publish callback, so a
// job that runs while the token is renewed uses the renewed token. The token
// captured when the job was accepted is the fallback if the runtime is gone.
func (s *Server) publishCallbackToken(prepared *preparedBuildPublish) func() string {
	return func() string {
		if token := s.workspaceCallbackToken(prepared.WorkspaceID); token != "" {
			return token
		}
		return prepared.Token
	}
}

type publishJobReporter struct {
	baseURL   string
	projectID string
	jobID     string
	token     func() string
	client    *http.Client
	log       *slog.Logger
}

func newPublishJobReporter(baseURL, projectID, jobID string, token func() string, client *http.Client, log *slog.Logger) *publishJobReporter {
	return &publishJobReporter{
		baseURL:   strings.TrimRight(baseURL, "/"),
		projectID: projectID,
		jobID:     jobID,
		token:     token,
		client:    client,
		log:       log.With("component", "publish-job-reporter", "publishJobId", jobID),
	}
}

func (r *publishJobReporter) Event(ctx context.Context, event publish.Event) {
	if r == nil || r.client == nil {
		return
	}
	if event.Level == "" {
		event.Level = "info"
	}
	raw, err := json.Marshal(event)
	if err != nil {
		r.log.Warn("marshal publish job event failed", "error", err)
		return
	}
	url := r.baseURL + "/api/projects/" + r.projectID + "/deployment-publish-jobs/" + r.jobID + "/events"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		r.log.Warn("create publish job event request failed", "error", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+r.token())
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		r.log.Warn("send publish job event failed", "eventType", event.EventType, "error", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		r.log.Warn("publish job event rejected", "eventType", event.EventType, "status", resp.StatusCode, "body", string(body))
	}
}
