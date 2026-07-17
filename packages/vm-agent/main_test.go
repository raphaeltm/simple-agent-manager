package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMainShutdownSourceContract(t *testing.T) {
	path := filepath.Join("main.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"Received signal",
		"StopAllWorkspacesAndSessions()",
		"srv.Stop(ctx)",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}

type shutdownTestServer struct {
	order           []string
	drainDeadline   time.Time
	stopDeadline    time.Time
	waitForDeadline bool
}

func (s *shutdownTestServer) DrainStandaloneSnapshot(ctx context.Context) error {
	s.order = append(s.order, "drain")
	s.drainDeadline, _ = ctx.Deadline()
	if s.waitForDeadline {
		<-ctx.Done()
		return ctx.Err()
	}
	return nil
}

func (s *shutdownTestServer) StopAllWorkspacesAndSessions() {
	s.order = append(s.order, "stop-work")
}

func (s *shutdownTestServer) Stop(ctx context.Context) error {
	s.order = append(s.order, "stop-server")
	s.stopDeadline, _ = ctx.Deadline()
	return ctx.Err()
}

func TestShutdownStandaloneUsesOneDeadlineAndOrdersDrainBeforeStop(t *testing.T) {
	s := &shutdownTestServer{}
	drainErr, stopErr := shutdownStandalone(s, time.Second)
	if drainErr != nil || stopErr != nil {
		t.Fatalf("shutdown errors = (%v, %v)", drainErr, stopErr)
	}
	if got := strings.Join(s.order, ","); got != "drain,stop-work,stop-server" {
		t.Fatalf("shutdown order = %q", got)
	}
	if !s.drainDeadline.Equal(s.stopDeadline) {
		t.Fatalf("deadlines differ: drain=%v stop=%v", s.drainDeadline, s.stopDeadline)
	}
}

func TestShutdownStandaloneIsBoundedBySharedDeadline(t *testing.T) {
	s := &shutdownTestServer{waitForDeadline: true}
	started := time.Now()
	drainErr, _ := shutdownStandalone(s, 20*time.Millisecond)
	if drainErr == nil {
		t.Fatal("expected deadline error")
	}
	if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
		t.Fatalf("shutdown elapsed %v, want bounded return", elapsed)
	}
	if got := strings.Join(s.order, ","); got != "drain,stop-work,stop-server" {
		t.Fatalf("shutdown order = %q", got)
	}
}
