package server

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

type snapshotProgressReporter struct {
	server        *Server
	workspaceID   string
	chatSessionID string
	generation    string
	token         string
	minInterval   time.Duration
	mu            sync.Mutex
	lastReported  time.Time
}

func newSnapshotProgressReporter(server *Server, workspaceID, chatSessionID, generation, token string) *snapshotProgressReporter {
	return &snapshotProgressReporter{
		server:        server,
		workspaceID:   workspaceID,
		chatSessionID: chatSessionID,
		generation:    generation,
		token:         token,
		minInterval:   server.sessionSnapshotProgressReportInterval(),
	}
}

func (s *Server) sessionSnapshotProgressReportInterval() time.Duration {
	if s != nil && s.config != nil && s.config.SessionSnapshotProgressReportInterval > 0 {
		return s.config.SessionSnapshotProgressReportInterval
	}
	return config.DefaultSessionSnapshotProgressReportInterval
}

func (s *Server) sessionSnapshotProgressReportTimeout() time.Duration {
	if s != nil && s.config != nil && s.config.SessionSnapshotProgressReportTimeout > 0 {
		return s.config.SessionSnapshotProgressReportTimeout
	}
	return config.DefaultSessionSnapshotProgressReportTimeout
}

func (r *snapshotProgressReporter) Report(ctx context.Context, step string) {
	if r == nil || r.server == nil || r.generation == "" || r.token == "" {
		return
	}
	if ctx.Err() != nil {
		return
	}
	now := time.Now()
	r.mu.Lock()
	if !r.lastReported.IsZero() && now.Sub(r.lastReported) < r.minInterval {
		r.mu.Unlock()
		return
	}
	r.lastReported = now
	r.mu.Unlock()

	reportCtx, cancel := context.WithTimeout(ctx, r.server.sessionSnapshotProgressReportTimeout())
	defer cancel()
	if err := r.server.reportSnapshotProgress(reportCtx, r.workspaceID, r.chatSessionID, r.generation, step, r.token); err != nil {
		slog.Warn("Session snapshot progress report failed", "chatSessionId", r.chatSessionID, "workspaceId", r.workspaceID, "step", step, "error", err)
	}
}
