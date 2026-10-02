package server

import (
	"archive/tar"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestSnapshotClaudeInstallDoesNotConsumeStateBudget(t *testing.T) {
	const limit = 8192
	for _, runtime := range []string{"standalone", "container"} {
		t.Run(runtime, func(t *testing.T) {
			home := t.TempDir()
			writeHomeFile(t, home, ".local/share/claude/versions/2.1.281", strings.Repeat("x", limit*2))
			state := map[string]string{
				".claude/projects/project/transcript.jsonl": "remember the user's work",
				".local/share/claude/notes.txt":             "retain non-install state",
				".local/share/claude/versions-backup/note":  "retain prefix neighbors",
				"notes.txt": "user work",
			}
			for path, body := range state {
				writeHomeFile(t, home, path, body)
			}
			capture := func() (map[string]bool, []snapshotSkippedEntry) {
				t.Helper()
				paths := make(map[string]bool)
				if runtime == "container" {
					args := containerHomeInventoryArgs(home)
					inventory, err := exec.Command(args[0], args[1:]...).Output()
					if err != nil {
						t.Fatal(err)
					}
					list, skipped, _, err := buildContainerHomeArchiveList(inventory, limit, limit)
					if err != nil {
						t.Fatal(err)
					}
					for _, path := range strings.Split(string(list), "\x00") {
						paths[path] = true
					}
					return paths, skipped
				}
				archive, skipped, err := createHomeTar(func() (string, error) { return home, nil }, limit, limit)
				if err != nil {
					t.Fatal(err)
				}
				defer os.Remove(archive)
				file, err := os.Open(archive)
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
				reader := tar.NewReader(file)
				for {
					header, err := reader.Next()
					if err == io.EOF {
						break
					}
					if err != nil {
						t.Fatal(err)
					}
					paths[header.Name] = true
					if want, ok := state[header.Name]; ok {
						body, err := io.ReadAll(reader)
						if err != nil || string(body) != want {
							t.Fatalf("state %s: got %q, error %v", header.Name, body, err)
						}
					}
				}
				return paths, skipped
			}
			paths, skipped := capture()
			if len(skipped) != 0 {
				t.Fatalf("reinstallable executable degraded the snapshot: %#v", skipped)
			}
			if paths[".local/share/claude/versions/2.1.281"] {
				t.Fatal("snapshot retained the reinstallable executable")
			}
			for path := range state {
				if !paths[path] {
					t.Errorf("snapshot lost state %s", path)
				}
			}
			writeHomeFile(t, home, "large-user-file", strings.Repeat("u", limit*2))
			_, skipped = capture()
			if len(skipped) != 1 || skipped[0].Path != "~/large-user-file" {
				t.Fatalf("omitted user work must still degrade capture: %#v", skipped)
			}
		})
	}
}
