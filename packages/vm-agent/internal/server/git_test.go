package server

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

func TestSanitizeFilePath(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{name: "valid simple file", path: "README.md", wantErr: false},
		{name: "valid nested path", path: "src/components/App.tsx", wantErr: false},
		{name: "valid deeply nested", path: "a/b/c/d/e/f.go", wantErr: false},
		{name: "valid path with spaces", path: "my files/test.txt", wantErr: false},
		{name: "valid path with dots in name", path: "src/utils.test.ts", wantErr: false},
		{name: "valid hidden file", path: ".gitignore", wantErr: false},
		{name: "valid hidden dir", path: ".github/workflows/ci.yml", wantErr: false},

		{name: "empty path", path: "", wantErr: true},
		{name: "path traversal basic", path: "../etc/passwd", wantErr: true},
		{name: "path traversal nested", path: "src/../../etc/passwd", wantErr: true},
		{name: "path traversal middle", path: "a/b/../../../etc/passwd", wantErr: true},
		{name: "absolute path", path: "/etc/passwd", wantErr: true},
		{name: "absolute path windows-style", path: "/home/user/secret", wantErr: true},
		{name: "null byte", path: "file\x00.txt", wantErr: true},
		{name: "null byte in middle", path: "src/\x00malicious", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := sanitizeFilePath(tt.path)
			if (err != nil) != tt.wantErr {
				t.Errorf("sanitizeFilePath(%q) error = %v, wantErr %v", tt.path, err, tt.wantErr)
			}
		})
	}
}

func TestSanitizeGitRef(t *testing.T) {
	tests := []struct {
		name    string
		ref     string
		wantErr bool
	}{
		{name: "HEAD", ref: "HEAD", wantErr: false},
		{name: "branch name", ref: "main", wantErr: false},
		{name: "tag", ref: "v1.0.0", wantErr: false},
		{name: "short hash", ref: "abc1234", wantErr: false},
		{name: "long hash", ref: "abc1234def5678", wantErr: false},
		{name: "relative ref", ref: "HEAD~1", wantErr: false},
		{name: "parent ref", ref: "HEAD^1", wantErr: false},
		{name: "branch with slash", ref: "origin/main", wantErr: false},

		{name: "empty", ref: "", wantErr: true},
		{name: "semicolon", ref: "HEAD;rm -rf /", wantErr: true},
		{name: "backtick", ref: "HEAD`whoami`", wantErr: true},
		{name: "dollar", ref: "HEAD$(cmd)", wantErr: true},
		{name: "pipe", ref: "HEAD|cat", wantErr: true},
		{name: "ampersand", ref: "HEAD&&cmd", wantErr: true},
		{name: "null byte", ref: "HEAD\x00", wantErr: true},
		{name: "space", ref: "HEAD 1", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := sanitizeGitRef(tt.ref)
			if (err != nil) != tt.wantErr {
				t.Errorf("sanitizeGitRef(%q) error = %v, wantErr %v", tt.ref, err, tt.wantErr)
			}
		})
	}
}

func TestParseGitStatusPorcelain(t *testing.T) {
	tests := []struct {
		name          string
		output        string
		wantStaged    []GitFileStatus
		wantUnstaged  []GitFileStatus
		wantUntracked []GitFileStatus
	}{
		{
			name:          "empty output",
			output:        "",
			wantStaged:    []GitFileStatus{},
			wantUnstaged:  []GitFileStatus{},
			wantUntracked: []GitFileStatus{},
		},
		{
			name:   "staged modified",
			output: "M  src/index.ts\n",
			wantStaged: []GitFileStatus{
				{Path: "src/index.ts", Status: "M"},
			},
			wantUnstaged:  []GitFileStatus{},
			wantUntracked: []GitFileStatus{},
		},
		{
			name:       "unstaged modified",
			output:     " M src/index.ts\n",
			wantStaged: []GitFileStatus{},
			wantUnstaged: []GitFileStatus{
				{Path: "src/index.ts", Status: "M"},
			},
			wantUntracked: []GitFileStatus{},
		},
		{
			name:   "staged added",
			output: "A  newfile.ts\n",
			wantStaged: []GitFileStatus{
				{Path: "newfile.ts", Status: "A"},
			},
			wantUnstaged:  []GitFileStatus{},
			wantUntracked: []GitFileStatus{},
		},
		{
			name:   "staged deleted",
			output: "D  oldfile.ts\n",
			wantStaged: []GitFileStatus{
				{Path: "oldfile.ts", Status: "D"},
			},
			wantUnstaged:  []GitFileStatus{},
			wantUntracked: []GitFileStatus{},
		},
		{
			name:          "untracked file",
			output:        "?? newfile.ts\n",
			wantStaged:    []GitFileStatus{},
			wantUnstaged:  []GitFileStatus{},
			wantUntracked: []GitFileStatus{{Path: "newfile.ts", Status: "??"}},
		},
		{
			name:   "renamed file",
			output: "R  old.ts -> new.ts\n",
			wantStaged: []GitFileStatus{
				{Path: "new.ts", Status: "R", OldPath: "old.ts"},
			},
			wantUnstaged:  []GitFileStatus{},
			wantUntracked: []GitFileStatus{},
		},
		{
			name:   "staged and unstaged (AM)",
			output: "AM newfile.ts\n",
			wantStaged: []GitFileStatus{
				{Path: "newfile.ts", Status: "A"},
			},
			wantUnstaged: []GitFileStatus{
				{Path: "newfile.ts", Status: "M"},
			},
			wantUntracked: []GitFileStatus{},
		},
		{
			name:   "staged and unstaged (MM)",
			output: "MM src/app.ts\n",
			wantStaged: []GitFileStatus{
				{Path: "src/app.ts", Status: "M"},
			},
			wantUnstaged: []GitFileStatus{
				{Path: "src/app.ts", Status: "M"},
			},
			wantUntracked: []GitFileStatus{},
		},
		{
			name:          "ignored files are skipped",
			output:        "!! node_modules/foo\n",
			wantStaged:    []GitFileStatus{},
			wantUnstaged:  []GitFileStatus{},
			wantUntracked: []GitFileStatus{},
		},
		{
			name: "mixed output",
			output: "M  src/index.ts\n" +
				" M README.md\n" +
				"A  lib/utils.ts\n" +
				"?? temp.txt\n" +
				"?? scratch/\n",
			wantStaged: []GitFileStatus{
				{Path: "src/index.ts", Status: "M"},
				{Path: "lib/utils.ts", Status: "A"},
			},
			wantUnstaged: []GitFileStatus{
				{Path: "README.md", Status: "M"},
			},
			wantUntracked: []GitFileStatus{
				{Path: "temp.txt", Status: "??"},
				{Path: "scratch/", Status: "??"},
			},
		},
		{
			name:          "short line ignored",
			output:        "X\n\n",
			wantStaged:    []GitFileStatus{},
			wantUnstaged:  []GitFileStatus{},
			wantUntracked: []GitFileStatus{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotStaged, gotUnstaged, gotUntracked := parseGitStatusPorcelain(tt.output)

			assertFileStatusSlice(t, "staged", gotStaged, tt.wantStaged)
			assertFileStatusSlice(t, "unstaged", gotUnstaged, tt.wantUnstaged)
			assertFileStatusSlice(t, "untracked", gotUntracked, tt.wantUntracked)
		})
	}
}

func TestFormatAsAdditions(t *testing.T) {
	result := formatAsAdditions("test.txt", "line1\nline2\nline3\n")

	if !containsSubstring(result, "--- /dev/null") {
		t.Error("expected /dev/null in diff header")
	}
	if !containsSubstring(result, "+++ b/test.txt") {
		t.Error("expected +++ b/test.txt in diff header")
	}
	if !containsSubstring(result, "@@ -0,0 +1,3 @@") {
		t.Errorf("expected hunk header @@ -0,0 +1,3 @@, got:\n%s", result)
	}
	if !containsSubstring(result, "+line1") {
		t.Error("expected +line1 in output")
	}
	if !containsSubstring(result, "+line2") {
		t.Error("expected +line2 in output")
	}
	if !containsSubstring(result, "+line3") {
		t.Error("expected +line3 in output")
	}
}

// ---------- Test helpers ----------

func assertFileStatusSlice(t *testing.T, label string, got, want []GitFileStatus) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("%s: got %d files, want %d. got=%+v want=%+v", label, len(got), len(want), got, want)
		return
	}
	for i := range want {
		if got[i].Path != want[i].Path {
			t.Errorf("%s[%d].Path = %q, want %q", label, i, got[i].Path, want[i].Path)
		}
		if got[i].Status != want[i].Status {
			t.Errorf("%s[%d].Status = %q, want %q", label, i, got[i].Status, want[i].Status)
		}
		if got[i].OldPath != want[i].OldPath {
			t.Errorf("%s[%d].OldPath = %q, want %q", label, i, got[i].OldPath, want[i].OldPath)
		}
	}
}

func containsSubstring(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsStr(s, substr))
}

func containsStr(s, substr string) bool {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func TestGitWorktreeQueryResolvesToValidatedWorkDir(t *testing.T) {
	t.Parallel()

	s := &Server{
		config: &config.Config{
			GitExecTimeout:   5 * time.Second,
			WorktreeCacheTTL: 5 * time.Second,
		},
		worktreeCache: map[string]cachedWorktreeList{},
	}
	s.setCachedWorktrees("ws-1", []WorktreeInfo{
		{Path: "/workspaces/repo", IsPrimary: true},
		{Path: "/workspaces/repo-wt-feature"},
	})

	req := httptest.NewRequest("GET", "/workspaces/ws-1/git/status?worktree=/workspaces/repo-wt-feature", nil)
	workDir, err := s.resolveWorktreeWorkDir(req, "ws-1", "container-1", "root", "/workspaces/repo")
	if err != nil {
		t.Fatalf("resolveWorktreeWorkDir() unexpected error: %v", err)
	}
	if workDir != "/workspaces/repo-wt-feature" {
		t.Fatalf("resolveWorktreeWorkDir() = %q, want /workspaces/repo-wt-feature", workDir)
	}
}
