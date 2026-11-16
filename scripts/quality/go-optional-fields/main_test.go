package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

var wantComment = regexp.MustCompile(`// want (unguarded|truthiness)$`)

// expectations reads `// want <kind>` annotations: every annotated line must be reported with
// that kind, and no other line may be reported.
func expectations(t *testing.T, dir string) map[string]string {
	t.Helper()
	want := map[string]string{}
	paths, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		file, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		scanner := bufio.NewScanner(file)
		for line := 1; scanner.Scan(); line++ {
			if match := wantComment.FindStringSubmatch(scanner.Text()); match != nil {
				want[fmt.Sprintf("%s:%d", filepath.Base(path), line)] = match[1]
			}
		}
		file.Close()
	}
	return want
}

func kindOf(message string) string {
	if strings.Contains(message, "only when that field is truthy") {
		return "truthiness"
	}
	return "unguarded"
}

func run(t *testing.T, dir string) (map[string]string, *Stats) {
	t.Helper()
	stats := &Stats{}
	findings, err := CheckDir(dir, stats)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, finding := range findings {
		key := fmt.Sprintf("%s:%d", filepath.Base(finding.Pos.Filename), finding.Pos.Line)
		if previous, seen := got[key]; seen && previous != kindOf(finding.Message) {
			t.Fatalf("%s reported twice with different kinds", key)
		}
		got[key] = kindOf(finding.Message)
	}
	return got, stats
}

func diff(want, got map[string]string) []string {
	var problems []string
	for key, kind := range want {
		if got[key] != kind {
			problems = append(problems, fmt.Sprintf("%s: want %s, got %q", key, kind, got[key]))
		}
	}
	for key, kind := range got {
		if _, expected := want[key]; !expected {
			problems = append(problems, fmt.Sprintf("%s: unexpected %s finding", key, kind))
		}
	}
	sort.Strings(problems)
	return problems
}

// Each fixture directory pins one family of shapes. fn, fp, load, gen and optoutedge are the
// variants a Go review of this checker produced (natural rewrites of the incident, and code
// that must not be reported).
func TestFixtureExpectations(t *testing.T) {
	cases := []struct {
		dir   string
		extra map[string]string // findings whose line cannot carry a want comment
		min   int               // minimum findings, so an empty run cannot pass
	}{
		{dir: "fn", min: 27},
		{dir: "fp", min: 7},
		{dir: "load", min: 4},
		{dir: "gen", min: 3},
		// A marker with no reason does not opt out; the lines cannot hold a want comment,
		// because it would become the reason.
		{dir: "optoutedge", extra: map[string]string{"optout.go:18": "unguarded", "optout.go:19": "unguarded"}, min: 3},
		{dir: "fixed"},
		{dir: "controls"},
		{dir: "truthiness", min: 2},
		{dir: "optout"},
		{dir: "patchparam", min: 2},
	}
	for _, tc := range cases {
		t.Run(tc.dir, func(t *testing.T) {
			dir := filepath.Join("testdata", tc.dir)
			want := expectations(t, dir)
			for key, kind := range tc.extra {
				want[key] = kind
			}
			if len(want) < tc.min {
				t.Fatalf("fixture has %d expectations, want at least %d", len(want), tc.min)
			}
			got, stats := run(t, dir)
			if stats.OptionFuncs == 0 {
				t.Fatalf("no function taking options was examined: %+v", stats)
			}
			if problems := diff(want, got); len(problems) > 0 {
				t.Fatalf("mismatches:\n%s", strings.Join(problems, "\n"))
			}
		})
	}
}

// The original incident: packages/vm-agent/internal/server/workspace_routing.go at a1c1d0040^
// (before #2055), verbatim. Exactly one finding, on the bool, while the thirteen guarded
// string fields beside it produce none.
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
	if len(findings) != 1 || !strings.Contains(findings[0].Message, "runtime.Lightweight is set from opt.Lightweight") ||
		kindOf(findings[0].Message) != "unguarded" {
		t.Fatalf("want exactly the Lightweight finding, got %v", findings)
	}
}

func TestStatsShowConstructionAndOptOut(t *testing.T) {
	_, stats := run(t, filepath.Join("testdata", "controls"))
	if stats.FreshSkipped == 0 || stats.ScalarCopies == 0 {
		t.Fatalf("controls should exercise construction and a guarded copy: %+v", stats)
	}
	_, stats = run(t, filepath.Join("testdata", "optout"))
	if stats.OptedOut != 1 {
		t.Fatalf("want one opted-out copy, got %+v", stats)
	}
}
