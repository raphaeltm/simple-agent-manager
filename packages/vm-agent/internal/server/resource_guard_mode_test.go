package server

import (
	"context"
	"io"
	"log/slog"
	"os/exec"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/resourcemon"
	"github.com/workspace/vm-agent/internal/sysinfo"
)

func TestResourceGuardStartsOnlyForWorkspaceVMRole(t *testing.T) {
	for _, role := range []string{config.RoleWorkspace, config.RoleStandalone, config.RoleDeployment} {
		t.Run(role, func(t *testing.T) {
			calls := make(chan string, 8)
			guard, err := resourcemon.NewResourceGuard(resourcemon.ResourceGuardConfig{
				PSIPollInterval:        time.Hour,
				ContainerStatsInterval: time.Hour,
				PSIThresholds:          resourcemon.PSIThresholds{MemorySomeWarningThreshold: 25, MemorySomeCriticalThreshold: 50, MemoryFullWarningThreshold: 10, MemoryFullCriticalThreshold: 25},
				Logger:                 slog.New(slog.NewTextHandler(io.Discard, nil)),
				DockerEventsCommand: func(ctx context.Context) *exec.Cmd {
					calls <- "docker-events"
					return exec.CommandContext(ctx, "/nonexistent-sam-resource-guard-test")
				},
				CollectDockerStats: func(context.Context, time.Duration, ...string) (map[string]sysinfo.DockerStatsEntry, error) {
					calls <- "docker-stats"
					return nil, nil
				},
				PressureReadFile: func(string) ([]byte, error) {
					calls <- "host-psi"
					return []byte("some avg10=0 avg60=0 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0\n"), nil
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			defer guard.Close()
			s := &Server{config: &config.Config{Role: role}, resourceGuard: guard, done: make(chan struct{})}
			defer close(s.done)
			s.startResourceGuard()
			if role != config.RoleWorkspace {
				select {
				case call := <-calls:
					t.Fatalf("%s started %s", role, call)
				case <-time.After(25 * time.Millisecond):
				}
				return
			}
			seen := make(map[string]bool)
			timeout := time.After(time.Second)
			for len(seen) < 3 {
				select {
				case call := <-calls:
					seen[call] = true
				case <-timeout:
					t.Fatalf("workspace role did not start resource collectors: %v", seen)
				}
			}
		})
	}
}
