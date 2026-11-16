package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func check(t *testing.T, dir string) ([]Finding, *Stats) {
	t.Helper()
	stats := &Stats{}
	findings, err := CheckDir(filepath.Join("testdata", dir), stats)
	if err != nil {
		t.Fatal(err)
	}
	return findings, stats
}

// The original incident: packages/vm-agent/internal/server/workspace_routing.go at
// a1c1d0040^ (before #2055), verbatim. It must produce exactly one finding, on the bool,
// while the thirteen guarded string fields beside it produce none.
func TestIncidentShapeIsReported(t *testing.T) {
	dir := t.TempDir()
	source, err := os.ReadFile(filepath.Join("testdata", "incident", "workspace_routing.go.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "workspace_routing.go"), source, 0o600); err != nil {
		t.Fatal(err)
	}
	stats := &Stats{}
	findings, err := CheckDir(dir, stats)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 {
		t.Fatalf("want 1 finding, got %d: %v", len(findings), findings)
	}
	if !strings.Contains(findings[0].Message, "runtime.Lightweight = opt.Lightweight") {
		t.Fatalf("unexpected finding: %s", findings[0].Message)
	}
	if stats.OptionFuncs != 1 {
		t.Fatalf("want the options function examined, got %d", stats.OptionFuncs)
	}
}

func TestFixedShapeIsClean(t *testing.T) {
	findings, stats := check(t, "fixed")
	if len(findings) != 0 {
		t.Fatalf("want no findings, got %v", findings)
	}
	// Liveness: the function was examined, so a clean result is not a skipped file.
	if stats.OptionFuncs != 1 || stats.Files != 1 {
		t.Fatalf("fixture was not examined: %+v", stats)
	}
}

func TestControlsAreClean(t *testing.T) {
	findings, stats := check(t, "controls")
	if len(findings) != 0 {
		t.Fatalf("want no findings, got %v", findings)
	}
	if stats.OptionFuncs != 2 || stats.ScalarCopies != 1 {
		t.Fatalf("controls not examined as expected: %+v", stats)
	}
}

func TestTruthinessGuardIsReported(t *testing.T) {
	findings, _ := check(t, "truthiness")
	if len(findings) != 2 {
		t.Fatalf("want 2 findings, got %d: %v", len(findings), findings)
	}
	for _, finding := range findings {
		if !strings.Contains(finding.Message, "guarded only by the truthiness") {
			t.Fatalf("unexpected message: %s", finding.Message)
		}
	}
}

func TestOptOutNeedsTheMarker(t *testing.T) {
	findings, stats := check(t, "optout")
	if len(findings) != 0 || stats.ScalarCopies != 1 {
		t.Fatalf("opt-out not honoured: %v %+v", findings, stats)
	}
}

func TestPatchParameterAndNamedEnum(t *testing.T) {
	findings, _ := check(t, "patchparam")
	if len(findings) != 2 {
		t.Fatalf("want 2 findings (Mode, Pin), got %d: %v", len(findings), findings)
	}
	if !strings.Contains(findings[0].Message, "p.Mode = patch.Mode") || !strings.Contains(findings[0].Message, "(Mode)") {
		t.Fatalf("named int enum not reported: %s", findings[0].Message)
	}
}
