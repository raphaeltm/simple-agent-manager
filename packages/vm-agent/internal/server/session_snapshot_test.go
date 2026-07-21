package server

import (
	"archive/tar"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

func TestCreateHomeTarExcludesCachesAndRecordsOversizedFiles(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".codex-session.jsonl"), []byte("session"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".cache"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".cache", "ignored"), []byte("cache"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "large.bin"), []byte("0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}

	tarPath, skipped, err := createHomeTar(func() (string, error) { return home, nil }, 8, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tarPath)

	if len(skipped) != 1 {
		t.Fatalf("skipped len = %d, want 1: %#v", len(skipped), skipped)
	}
	if skipped[0].Path != "~/large.bin" {
		t.Fatalf("skipped path = %q, want ~/large.bin", skipped[0].Path)
	}

	names := tarNames(t, tarPath)
	if !containsString(names, ".codex-session.jsonl") {
		t.Fatalf("tar names missing session file: %#v", names)
	}
	if containsString(names, ".cache/ignored") {
		t.Fatalf("tar names included cache file: %#v", names)
	}
	if containsString(names, "large.bin") {
		t.Fatalf("tar names included oversized file: %#v", names)
	}
}

func TestCreateWIPBundleDegradesDuringMerge(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	repo := t.TempDir()
	runGit(t, repo, "init")
	runGit(t, repo, "config", "user.email", "sam@example.test")
	runGit(t, repo, "config", "user.name", "SAM")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("base"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "README.md")
	runGit(t, repo, "commit", "-m", "base")
	if err := os.WriteFile(filepath.Join(repo, ".git", "MERGE_HEAD"), []byte("deadbeef"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, bundlePath, skipped, err := createWIPBundle(context.Background(), repo, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if bundlePath != "" {
		t.Fatalf("bundlePath = %q, want empty during merge", bundlePath)
	}
	if len(skipped) != 1 || skipped[0].Reason != "git operation in progress" {
		t.Fatalf("skipped = %#v, want git operation degradation", skipped)
	}
}

func TestSnapshotHarnessResumeIdentity(t *testing.T) {
	tests := []struct {
		name          string
		manifest      *snapshotManifest
		sessionID     string
		agentType     string
		wantACP       string
		wantAgentType string
		wantErr       bool
	}{
		{
			name: "restores exact saved harness",
			manifest: &snapshotManifest{
				AgentSessionID: "agent-session-1",
				AcpSessionID:   "acp-session-1",
				AgentType:      "openai-codex",
			},
			sessionID:     "agent-session-1",
			agentType:     "openai-codex",
			wantACP:       "acp-session-1",
			wantAgentType: "openai-codex",
		},
		{
			name:      "rejects legacy snapshot without harness identity",
			manifest:  &snapshotManifest{AgentSessionID: "agent-session-1"},
			sessionID: "agent-session-1",
			agentType: "openai-codex",
			wantErr:   true,
		},
		{
			name: "rejects agent session mismatch",
			manifest: &snapshotManifest{
				AgentSessionID: "agent-session-other",
				AcpSessionID:   "acp-session-1",
				AgentType:      "openai-codex",
			},
			sessionID: "agent-session-1",
			agentType: "openai-codex",
			wantErr:   true,
		},
		{
			name: "rejects agent type mismatch",
			manifest: &snapshotManifest{
				AgentSessionID: "agent-session-1",
				AcpSessionID:   "acp-session-1",
				AgentType:      "claude-code",
			},
			sessionID: "agent-session-1",
			agentType: "openai-codex",
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			acpSessionID, agentType, err := snapshotHarnessResumeIdentity(tt.manifest, tt.sessionID, tt.agentType)
			if tt.wantErr {
				if err == nil {
					t.Fatal("snapshotHarnessResumeIdentity returned nil error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if acpSessionID != tt.wantACP || agentType != tt.wantAgentType {
				t.Fatalf("identity = (%q, %q), want (%q, %q)", acpSessionID, agentType, tt.wantACP, tt.wantAgentType)
			}
		})
	}
}

func TestDownloadAndExtractTarRejectsPathTraversal(t *testing.T) {
	home := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	absolute := filepath.Join(t.TempDir(), "absolute.txt")
	t.Setenv("HOME", home)

	var tarBody bytes.Buffer
	tw := tar.NewWriter(&tarBody)
	writeTarFile(t, tw, "session.jsonl", "inside")
	writeTarFile(t, tw, "../outside.txt", "outside")
	writeTarFile(t, tw, absolute, "absolute")
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(tarBody.Bytes())
	}))
	defer server.Close()

	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	if err := s.downloadAndExtractTar(context.Background(), "/artifact", "token", time.Second); err != nil {
		t.Fatal(err)
	}

	if got, err := os.ReadFile(filepath.Join(home, "session.jsonl")); err != nil || string(got) != "inside" {
		t.Fatalf("inside file = %q, %v; want inside", got, err)
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("outside file stat err = %v, want not exist", err)
	}
	if _, err := os.Stat(absolute); !os.IsNotExist(err) {
		t.Fatalf("absolute file stat err = %v, want not exist", err)
	}
}

func tarNames(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tr := tar.NewReader(f)
	var names []string
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return names
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, header.Name)
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
}

func writeTarFile(t *testing.T, tw *tar.Writer, name, body string) {
	t.Helper()
	if err := tw.WriteHeader(&tar.Header{
		Name: name,
		Mode: 0o600,
		Size: int64(len(body)),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
