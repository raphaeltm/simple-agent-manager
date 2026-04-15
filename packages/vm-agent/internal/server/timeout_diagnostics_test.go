package server

import (
	"context"
	"fmt"
	"strings"
	"syscall"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/sysinfo"
)

// stubCollector returns a sysinfo.Collector with injectable procfs data for testing.
func stubCollector(loadAvg1, memPercent, diskPercent float64) *sysinfo.Collector {
	c := sysinfo.NewCollector(sysinfo.CollectorConfig{})
	c.SetReadFileFunc(func(path string) (string, error) {
		switch path {
		case "/proc/loadavg":
			return fmt.Sprintf("%.2f 0.00 0.00 1/1 1", loadAvg1), nil
		case "/proc/meminfo":
			total := uint64(1000000) // kB
			available := uint64(float64(total) * (100 - memPercent) / 100)
			return fmt.Sprintf("MemTotal: %d kB\nMemAvailable: %d kB\n", total, available), nil
		default:
			return "", fmt.Errorf("stub: unknown path %s", path)
		}
	})
	c.SetStatFSFunc(func(_ string) (*syscall.Statfs_t, error) {
		totalBlocks := uint64(1000000)
		bsize := int64(4096)
		usedBlocks := uint64(float64(totalBlocks) * diskPercent / 100)
		freeBlocks := totalBlocks - usedBlocks
		return &syscall.Statfs_t{
			Blocks: totalBlocks,
			Bsize:  bsize,
			Bfree:  freeBlocks,
			Bavail: freeBlocks,
		}, nil
	})
	return c
}

func failingCollector() *sysinfo.Collector {
	c := sysinfo.NewCollector(sysinfo.CollectorConfig{})
	c.SetReadFileFunc(func(_ string) (string, error) {
		return "", fmt.Errorf("stub: procfs unavailable")
	})
	return c
}

func newTestServerWithCollector(collector *sysinfo.Collector) *Server {
	return &Server{
		config: &config.Config{
			DiagCPUSaturationThreshold: 2.0,
			DiagMemExhaustedThreshold:  90,
			DiagDiskFullThreshold:      90,
		},
		sysInfoCollector: collector,
	}
}

func TestBuildTimeoutDiagnostics_TimeoutWithHighResources(t *testing.T) {
	// CPU load 7.2 on N cores — on a 2-core machine that's 3.6x per core (saturated).
	// Memory 94% (exhausted), Disk 45% (fine).
	s := newTestServerWithCollector(stubCollector(7.2, 94, 45))

	err := context.DeadlineExceeded
	msg, diag := s.buildTimeoutDiagnostics(err)

	if diag == nil {
		t.Fatal("expected diagnostics for timeout error, got nil")
	}

	// CPU saturation depends on runtime.NumCPU(). Check the per-core value.
	if diag.NumCPU <= 0 {
		t.Errorf("expected positive NumCPU, got %d", diag.NumCPU)
	}
	if !diag.MemExhausted {
		t.Error("expected MemExhausted=true")
	}
	if diag.DiskFull {
		t.Error("expected DiskFull=false")
	}

	if !strings.Contains(msg, "Workspace build timed out") {
		t.Errorf("expected timeout message, got: %s", msg)
	}
	if !strings.Contains(msg, "memory") {
		t.Errorf("expected 'memory' in message, got: %s", msg)
	}
	if !strings.Contains(msg, "larger VM size") {
		t.Errorf("expected 'larger VM size' suggestion, got: %s", msg)
	}
}

func TestBuildTimeoutDiagnostics_TimeoutWithNormalResources(t *testing.T) {
	// CPU load 0.5 (fine on any machine), Memory 40% (fine), Disk 30% (fine)
	s := newTestServerWithCollector(stubCollector(0.5, 40, 30))

	err := context.DeadlineExceeded
	msg, diag := s.buildTimeoutDiagnostics(err)

	if diag == nil {
		t.Fatal("expected diagnostics for timeout error, got nil")
	}

	if diag.CPUSaturated {
		t.Error("expected CPUSaturated=false")
	}
	if diag.MemExhausted {
		t.Error("expected MemExhausted=false")
	}
	if diag.DiskFull {
		t.Error("expected DiskFull=false")
	}

	if !strings.Contains(msg, "Workspace build timed out") {
		t.Errorf("expected timeout message, got: %s", msg)
	}
	// Should NOT contain "constrained" or "larger VM" when resources are fine
	if strings.Contains(msg, "constrained") {
		t.Errorf("should not suggest constraint when resources are normal, got: %s", msg)
	}
	if strings.Contains(msg, "larger VM size") {
		t.Errorf("should not suggest larger VM when resources are normal, got: %s", msg)
	}
}

func TestBuildTimeoutDiagnostics_NonTimeoutError(t *testing.T) {
	s := newTestServerWithCollector(stubCollector(7.2, 94, 95))

	origErr := fmt.Errorf("devcontainer build failed: exit code 1")
	msg, diag := s.buildTimeoutDiagnostics(origErr)

	if diag != nil {
		t.Fatal("expected nil diagnostics for non-timeout error")
	}

	if msg != origErr.Error() {
		t.Errorf("expected original error message %q, got %q", origErr.Error(), msg)
	}
}

func TestBuildTimeoutDiagnostics_WrappedTimeoutError(t *testing.T) {
	s := newTestServerWithCollector(stubCollector(1.0, 50, 50))

	// Simulate the wrapped error from provisionWorkspaceRuntime
	wrappedErr := fmt.Errorf("provision failed: %w", context.DeadlineExceeded)
	msg, diag := s.buildTimeoutDiagnostics(wrappedErr)

	if diag == nil {
		t.Fatal("expected diagnostics for wrapped timeout error, got nil")
	}

	if !strings.Contains(msg, "Workspace build timed out") {
		t.Errorf("expected timeout message, got: %s", msg)
	}
}

func TestBuildTimeoutDiagnostics_SysinfoFailure(t *testing.T) {
	s := newTestServerWithCollector(failingCollector())

	err := context.DeadlineExceeded
	msg, diag := s.buildTimeoutDiagnostics(err)

	if diag != nil {
		t.Fatal("expected nil diagnostics when sysinfo fails")
	}

	if msg != err.Error() {
		t.Errorf("expected original error message %q, got %q", err.Error(), msg)
	}
}

// TestDiagnosticsIntegration_NodeEventDetail verifies that the integration code
// pattern used in startWorkspaceProvision correctly adds resourceDiagnostics to
// the node event detail map when diagnostics are non-nil, and omits it otherwise.
func TestDiagnosticsIntegration_NodeEventDetail(t *testing.T) {
	// This test exercises the exact code pattern from startWorkspaceProvision:
	//   errorMsg, diag := s.buildTimeoutDiagnostics(err)
	//   failureDetail["error"] = errorMsg
	//   if diag != nil { failureDetail["resourceDiagnostics"] = diag }

	t.Run("timeout error includes diagnostics in detail map", func(t *testing.T) {
		s := newTestServerWithCollector(stubCollector(7.2, 94, 45))
		errorMsg, diag := s.buildTimeoutDiagnostics(context.DeadlineExceeded)

		detail := map[string]interface{}{"error": errorMsg}
		if diag != nil {
			detail["resourceDiagnostics"] = diag
		}

		rd, ok := detail["resourceDiagnostics"]
		if !ok {
			t.Fatal("expected resourceDiagnostics in detail map")
		}
		diagResult, ok := rd.(*resourceDiagnostics)
		if !ok {
			t.Fatalf("expected *resourceDiagnostics, got %T", rd)
		}
		if diagResult.Metrics == nil {
			t.Error("expected non-nil Metrics in resourceDiagnostics")
		}
		if diagResult.NumCPU <= 0 {
			t.Errorf("expected positive NumCPU in diagnostics, got %d", diagResult.NumCPU)
		}
	})

	t.Run("non-timeout error omits diagnostics from detail map", func(t *testing.T) {
		s := newTestServerWithCollector(stubCollector(7.2, 94, 95))
		errorMsg, diag := s.buildTimeoutDiagnostics(fmt.Errorf("build failed"))

		detail := map[string]interface{}{"error": errorMsg}
		if diag != nil {
			detail["resourceDiagnostics"] = diag
		}

		if _, ok := detail["resourceDiagnostics"]; ok {
			t.Error("resourceDiagnostics should not be in detail map for non-timeout errors")
		}
	})
}

func TestBuildTimeoutDiagnostics_DiskFullOnly(t *testing.T) {
	s := newTestServerWithCollector(stubCollector(0.5, 40, 95))

	err := context.DeadlineExceeded
	msg, diag := s.buildTimeoutDiagnostics(err)

	if diag == nil {
		t.Fatal("expected diagnostics, got nil")
	}

	if diag.CPUSaturated {
		t.Error("expected CPUSaturated=false")
	}
	if diag.MemExhausted {
		t.Error("expected MemExhausted=false")
	}
	if !diag.DiskFull {
		t.Error("expected DiskFull=true")
	}

	if !strings.Contains(msg, "disk constrained") {
		t.Errorf("expected 'disk constrained' in message, got: %s", msg)
	}
	if !strings.Contains(msg, "larger VM size") {
		t.Errorf("expected 'larger VM size' suggestion, got: %s", msg)
	}
}

func TestBuildTimeoutDiagnostics_CustomThresholds(t *testing.T) {
	// With custom thresholds: CPU > 1.0 per core, memory > 50%, disk > 50%
	// Even moderate resource usage should trigger all constraints.
	s := &Server{
		config: &config.Config{
			DiagCPUSaturationThreshold: 1.0,
			DiagMemExhaustedThreshold:  50,
			DiagDiskFullThreshold:      50,
		},
		sysInfoCollector: stubCollector(4.0, 60, 60),
	}

	msg, diag := s.buildTimeoutDiagnostics(context.DeadlineExceeded)

	if diag == nil {
		t.Fatal("expected diagnostics, got nil")
	}

	// On any machine, 4.0 / numCPU > 1.0 as long as numCPU < 4.
	// Memory 60% > 50%, Disk 60% > 50%.
	if !diag.MemExhausted {
		t.Error("expected MemExhausted=true with custom threshold of 50%")
	}
	if !diag.DiskFull {
		t.Error("expected DiskFull=true with custom threshold of 50%")
	}
	if !strings.Contains(msg, "larger VM size") {
		t.Errorf("expected 'larger VM size' suggestion with custom thresholds, got: %s", msg)
	}
}
