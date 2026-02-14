package server

import (
	"testing"
)

func TestParseFileListOutput(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []FileEntry
	}{
		{
			name:     "empty output",
			input:    "",
			expected: []FileEntry{},
		},
		{
			name:     "whitespace only",
			input:    "   \n  \n",
			expected: []FileEntry{},
		},
		{
			name:  "single directory",
			input: "d\t4096\t1707926400.000000000\tsrc\n",
			expected: []FileEntry{
				{Name: "src", Type: "dir", Size: 4096, ModifiedAt: "2024-02-14T16:00:00Z"},
			},
		},
		{
			name:  "single file",
			input: "f\t1234\t1707926400.000000000\tREADME.md\n",
			expected: []FileEntry{
				{Name: "README.md", Type: "file", Size: 1234, ModifiedAt: "2024-02-14T16:00:00Z"},
			},
		},
		{
			name:  "symlink",
			input: "l\t42\t1707926400.000000000\tlink.txt\n",
			expected: []FileEntry{
				{Name: "link.txt", Type: "symlink", Size: 42, ModifiedAt: "2024-02-14T16:00:00Z"},
			},
		},
		{
			name: "mixed entries",
			input: "d\t4096\t1707926400.000000000\tsrc\n" +
				"f\t512\t1707926400.000000000\tmain.go\n" +
				"d\t4096\t1707926400.000000000\tpkg\n" +
				"f\t2048\t1707926400.000000000\tgo.mod\n",
			expected: []FileEntry{
				{Name: "src", Type: "dir", Size: 4096, ModifiedAt: "2024-02-14T16:00:00Z"},
				{Name: "main.go", Type: "file", Size: 512, ModifiedAt: "2024-02-14T16:00:00Z"},
				{Name: "pkg", Type: "dir", Size: 4096, ModifiedAt: "2024-02-14T16:00:00Z"},
				{Name: "go.mod", Type: "file", Size: 2048, ModifiedAt: "2024-02-14T16:00:00Z"},
			},
		},
		{
			name:     "skips . and ..",
			input:    "d\t4096\t1707926400.000000000\t.\nd\t4096\t1707926400.000000000\t..\nf\t100\t1707926400.000000000\tfile.txt\n",
			expected: []FileEntry{{Name: "file.txt", Type: "file", Size: 100, ModifiedAt: "2024-02-14T16:00:00Z"}},
		},
		{
			name:     "malformed line (too few tabs)",
			input:    "d\t4096\tsrc\n",
			expected: []FileEntry{},
		},
		{
			name:  "epoch without decimal",
			input: "f\t100\t1707926400\tfile.txt\n",
			expected: []FileEntry{
				{Name: "file.txt", Type: "file", Size: 100, ModifiedAt: "2024-02-14T16:00:00Z"},
			},
		},
		{
			name:  "file with spaces in name",
			input: "f\t100\t1707926400.000000000\tmy file.txt\n",
			expected: []FileEntry{
				{Name: "my file.txt", Type: "file", Size: 100, ModifiedAt: "2024-02-14T16:00:00Z"},
			},
		},
		{
			name:  "file with tabs in name (SplitN limits to 4)",
			input: "f\t100\t1707926400.000000000\tmy\tfile.txt\n",
			expected: []FileEntry{
				{Name: "my\tfile.txt", Type: "file", Size: 100, ModifiedAt: "2024-02-14T16:00:00Z"},
			},
		},
		{
			name:  "zero-size file",
			input: "f\t0\t1707926400.000000000\tempty.txt\n",
			expected: []FileEntry{
				{Name: "empty.txt", Type: "file", Size: 0, ModifiedAt: "2024-02-14T16:00:00Z"},
			},
		},
		{
			name:  "hidden file (dotfile)",
			input: "f\t256\t1707926400.000000000\t.gitignore\n",
			expected: []FileEntry{
				{Name: ".gitignore", Type: "file", Size: 256, ModifiedAt: "2024-02-14T16:00:00Z"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := parseFileListOutput(tt.input)

			if len(result) != len(tt.expected) {
				t.Fatalf("expected %d entries, got %d: %+v", len(tt.expected), len(result), result)
			}

			for i, entry := range result {
				exp := tt.expected[i]
				if entry.Name != exp.Name {
					t.Errorf("entry[%d].Name = %q, want %q", i, entry.Name, exp.Name)
				}
				if entry.Type != exp.Type {
					t.Errorf("entry[%d].Type = %q, want %q", i, entry.Type, exp.Type)
				}
				if entry.Size != exp.Size {
					t.Errorf("entry[%d].Size = %d, want %d", i, entry.Size, exp.Size)
				}
				if entry.ModifiedAt != exp.ModifiedAt {
					t.Errorf("entry[%d].ModifiedAt = %q, want %q", i, entry.ModifiedAt, exp.ModifiedAt)
				}
			}
		})
	}
}
