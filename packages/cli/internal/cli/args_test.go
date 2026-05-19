package cli

import "testing"

func TestParseArgsHandlesGlobalFlagsCommandFlagsAndPositionals(t *testing.T) {
	parsed, err := parseArgs([]string{
		"--json",
		"--project", "project_1",
		"tasks",
		"dispatch",
		"--agent=sam",
		"--mode", "task",
		"ship",
		"the",
		"feature",
		"--dry-run",
	})
	if err != nil {
		t.Fatal(err)
	}

	if !parsed.Globals.JSON || parsed.Globals.Project != "project_1" {
		t.Fatalf("globals = %#v", parsed.Globals)
	}
	assertStringSlice(t, parsed.Positionals, []string{"tasks", "dispatch", "ship", "the", "feature"})
	if parsed.Flags["agent"] != "sam" || parsed.Flags["mode"] != "task" {
		t.Fatalf("flags = %#v", parsed.Flags)
	}
	if !parsed.Bools["dry-run"] {
		t.Fatalf("bool flags = %#v", parsed.Bools)
	}
}

func TestParseArgsReportsMalformedFlags(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "missing project value", args: []string{"--project"}},
		{name: "empty flag name", args: []string{"--"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := parseArgs(tt.args); err == nil {
				t.Fatal("expected parse error")
			}
		})
	}
}

func assertStringSlice(t *testing.T, got []string, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("len(%#v) = %d, want %d", got, len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got[%d] = %q, want %q; full slice = %#v", i, got[i], want[i], got)
		}
	}
}
