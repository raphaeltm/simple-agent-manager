package server

import (
	"context"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/publish"
)

// Heartbeats measure whether the executor is alive, not whether Docker produced
// progress. They carry no status or step and stop before the terminal callback.
func (s *Server) startPublishJobHeartbeats(parent context.Context, reporter publish.EventSink) func() {
	interval := s.config.DeployPublishHeartbeatInterval
	if interval <= 0 {
		interval = config.DefaultDeployPublishHeartbeatInterval
	}
	timeout := s.config.HTTPCallbackTimeout
	if timeout <= 0 {
		timeout = config.DefaultHTTPCallbackTimeout
	}
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		send := func() {
			attempt, abort := context.WithTimeout(ctx, timeout)
			defer abort()
			reporter.Event(attempt, publish.Event{EventType: "publish.job.heartbeat", Message: "publish executor is alive"})
		}
		send() // Establish heartbeat capability immediately, including during a silent build.
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				send()
			}
		}
	}()
	return func() { cancel(); <-done }
}
