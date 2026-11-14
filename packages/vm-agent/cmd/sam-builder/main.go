package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/workspace/vm-agent/internal/builder"
	"github.com/workspace/vm-agent/internal/sysinfo"
)

const bootstrapTimeout = 60 * time.Second
const controllerAddress = ":8080"
const maxLaunchBytes = 16 * 1024

func durationEnv(name string, fallback time.Duration) time.Duration {
	value, err := strconv.Atoi(os.Getenv(name))
	if err == nil && value > 0 {
		return time.Duration(value) * time.Millisecond
	}
	return fallback
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "sam-builder stopped:", err)
		os.Exit(1)
	}
}
func run() error {
	bootstrapBudget := durationEnv("SAM_BUILDER_BOOTSTRAP_TIMEOUT_MS", bootstrapTimeout)
	controlBudget := durationEnv("SAM_BUILDER_CONTROL_TIMEOUT_MS", builder.DefaultCallbackTimeout)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	listener, err := net.Listen("tcp", controllerAddress)
	if err != nil {
		return err
	}
	launches := make(chan builder.Launch, 1)
	var once sync.Once
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"version": sysinfo.Version})
	})
	mux.HandleFunc("POST /start", func(w http.ResponseWriter, r *http.Request) {
		var launch builder.Launch
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLaunchBytes)).Decode(&launch); err != nil || launch.Token == "" || launch.ProjectID == "" || launch.JobID == "" || launch.Attempt < 1 || launch.DeadlineAt.Before(time.Now()) {
			http.Error(w, "invalid launch", http.StatusBadRequest)
			return
		}
		accepted := false
		once.Do(func() { launches <- launch; accepted = true })
		if !accepted {
			http.Error(w, "already accepted", http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: controlBudget, ReadTimeout: controlBudget, WriteTimeout: controlBudget}
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Serve(listener) }()
	timer := time.NewTimer(bootstrapBudget)
	defer timer.Stop()
	defer server.Close()
	select {
	case launch := <-launches:
		// Close the bootstrap listener before any Dockerfile runs. A RUN with host
		// networking can neither retrieve a token nor submit a second launch.
		shutdownCtx, stop := context.WithTimeout(ctx, controlBudget)
		defer stop()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return errors.New("controller shutdown failed")
		}
		return builder.Run(ctx, launch)
	case <-ctx.Done():
		return ctx.Err()
	case err := <-serverErr:
		return err
	case <-timer.C:
		return errors.New("builder bootstrap deadline")
	}
}
