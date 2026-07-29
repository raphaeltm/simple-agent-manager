package server

import (
	"bytes"
	"context"
	"net/http"
	"runtime/pprof"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/errorreport"
	"github.com/workspace/vm-agent/internal/messagereport"
	"github.com/workspace/vm-agent/internal/ports"
)

func newShutdownTestServer(t *testing.T) *Server {
	t.Helper()

	sessionManager := auth.NewSessionManagerWithConfig(auth.SessionManagerConfig{
		CookieName:      "vm_session",
		Secure:          false,
		TTL:             time.Hour,
		CleanupInterval: time.Hour,
		MaxSessions:     100,
	})

	errorReporter := errorreport.New("", "node-1", "", errorreport.Config{FlushInterval: time.Hour})
	errorReporter.Start()

	return &Server{
		config:           &config.Config{},
		httpServer:       &http.Server{},
		jwtValidator:     &auth.JWTValidator{},
		sessionManager:   sessionManager,
		workspaces:       make(map[string]*WorkspaceRuntime),
		sessionHosts:     make(map[string]*acp.SessionHost),
		messageReporters: make(map[string]*messagereport.Reporter),
		portScanners:     make(map[string]*ports.Scanner),
		portDiscoveries:  make(map[string]*container.Discovery),
		errorReporter:    errorReporter,
		done:             make(chan struct{}),
	}
}

func authCleanupGoroutines(t *testing.T) int {
	t.Helper()

	var buf bytes.Buffer
	if err := pprof.Lookup("goroutine").WriteTo(&buf, 2); err != nil {
		t.Fatalf("write goroutine profile: %v", err)
	}
	return strings.Count(buf.String(), "github.com/workspace/vm-agent/internal/auth.(*SessionManager).cleanup")
}

func waitForAuthCleanupCount(t *testing.T, want int) {
	t.Helper()

	deadline := time.After(2 * time.Second)
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()

	for {
		if got := authCleanupGoroutines(t); got == want {
			return
		}
		select {
		case <-tick.C:
		case <-deadline:
			t.Fatalf("auth cleanup goroutine count = %d, want %d", authCleanupGoroutines(t), want)
		}
	}
}

func TestServerStopIsIdempotentAndStopsAuthCleanup(t *testing.T) {
	baseline := authCleanupGoroutines(t)
	s := newShutdownTestServer(t)
	waitForAuthCleanupCount(t, baseline+1)

	if err := s.Stop(context.Background()); err != nil {
		t.Fatalf("first Stop returned error: %v", err)
	}
	if err := s.Stop(context.Background()); err != nil {
		t.Fatalf("second Stop returned error: %v", err)
	}

	waitForAuthCleanupCount(t, baseline)
}

func TestServerStopIsSafeUnderConcurrentCalls(t *testing.T) {
	s := newShutdownTestServer(t)

	const callers = 16
	var wg sync.WaitGroup
	errs := make(chan error, callers)
	wg.Add(callers)
	for i := 0; i < callers; i++ {
		go func() {
			defer wg.Done()
			errs <- s.Stop(context.Background())
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent Stop returned error: %v", err)
		}
	}
}
