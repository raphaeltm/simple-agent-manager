package server

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/pty"
)

func TestStandaloneWorkspacePTYProvidesScopedGitEnvironment(t *testing.T) {
	for _, binary := range []string{"git", "curl"} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Skip(binary + " required")
		}
	}
	t.Setenv("SAM_WORKSPACE_ID", "inherited-other-workspace")
	t.Setenv("SAM_API_URL", "https://inherited.invalid")
	t.Setenv("GIT_CONFIG_COUNT", "0")
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	s := &Server{config: &config.Config{Role: config.RoleStandalone, WorkspaceID: "launch-workspace", ControlPlaneURL: "https://api.example.com/"}, workspaces: map[string]*WorkspaceRuntime{}}
	for _, workspaceID := range []string{"launch-workspace", "terminal-one", "terminal-two"} {
		t.Run(workspaceID, func(t *testing.T) {
			exchange := newStandaloneCredentialExchange(t, workspaceID, http.StatusOK, "synthetic-fresh-credential")
			t.Setenv("SAM_GIT_CREDENTIAL_ENDPOINT", exchange.endpoint)
			dir := t.TempDir()
			resultPath := filepath.Join(dir, "result")
			shellPath := filepath.Join(dir, "shell")
			script := fmt.Sprintf(`#!/bin/sh
if [ "$SAM_WORKSPACE_ID" != %q ] || [ "$SAM_API_URL" != 'https://api.example.com' ]; then
 printf 'wrong-identity' > %q
 exit 1
fi
credential=$(printf 'protocol=https\nhost=github.com\n\n' | git -c credential.helper= -c credential.helper=%q credential fill 2>/dev/null)
case "$credential" in
 *'password=synthetic-fresh-credential'*) printf 'verified' > %q ;;
 *) printf 'credential-failed' > %q ;;
esac
`, workspaceID, resultPath, exchange.helperPath, resultPath, resultPath)
			if err := os.WriteFile(shellPath, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			s.config.DefaultShell = shellPath
			s.ptyManager = pty.NewManager(pty.ManagerConfig{
				DefaultShell: shellPath,
				WorkDir:      dir,
				Env:          standalonePTYEnvironment(s.config, s.config.WorkspaceID),
				ProcessGroup: true,
			})
			manager := s.newPTYManagerForWorkspace(workspaceID, dir, dir, dir, "")
			_, err := manager.CreateSession("test-user", 24, 80)
			if err != nil {
				t.Fatalf("create real PTY: %v", err)
			}
			defer manager.CloseAllSessions()
			deadline := time.Now().Add(10 * time.Second)
			for {
				if data, err := os.ReadFile(resultPath); err == nil && len(data) > 0 {
					if strings.TrimSpace(string(data)) != "verified" {
						t.Fatal("PTY did not provide scoped identity and fresh Git credential")
					}
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("PTY credential fixture timed out")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if exchange.mintCalls.Load() != 1 || exchange.lastRequestQuery().Get("workspaceId") != workspaceID {
				t.Fatal("PTY credential exchange used the wrong workspace")
			}
		})
	}
	if os.Getenv("SAM_WORKSPACE_ID") != "inherited-other-workspace" {
		t.Fatal("PTY creation changed process-global identity")
	}
}
