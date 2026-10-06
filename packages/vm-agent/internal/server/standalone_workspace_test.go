package server

import "testing"

func TestStandaloneCloneWarnings(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   string
	}{
		{name: "no warnings", output: "Cloning into '/workspaces/repo'...\ndone.", want: ""},
		{
			name:   "filter ignored warning surfaces",
			output: "Cloning into '/workspaces/repo'...\nwarning: filtering not recognized by server, ignoring\ndone.",
			want:   "warning: filtering not recognized by server, ignoring",
		},
		{
			name:   "multiple warnings joined",
			output: "warning: one\nprogress line\nWarning: two",
			want:   "warning: one; Warning: two",
		},
		{name: "empty output", output: "", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := standaloneCloneWarnings(tc.output); got != tc.want {
				t.Fatalf("standaloneCloneWarnings(%q) = %q, want %q", tc.output, got, tc.want)
			}
		})
	}
}

func TestStandaloneCloneWarningsBounded(t *testing.T) {
	long := "warning: " + string(make([]byte, 4096))
	if got := standaloneCloneWarnings(long); len(got) > 1024 {
		t.Fatalf("warnings length = %d, want <= 1024", len(got))
	}
}
