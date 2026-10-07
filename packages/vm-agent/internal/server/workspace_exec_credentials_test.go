package server

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func TestStandaloneRuntimeGitCommandUsesTrustedWorkspaceCredentialExchange(t *testing.T) {
	exchange := newStandaloneCredentialExchange(t, "owned-workspace", http.StatusOK, "fresh-runtime-token")
	t.Setenv("SAM_WORKSPACE_ID", "other-workspace")
	t.Setenv("GH_TOKEN", "stale-runtime-token")
	t.Setenv("GITHUB_TOKEN", "stale-other-token")
	s := &Server{config: &config.Config{Role: config.RoleStandalone, WorkspaceID: exchange.workspaceID}}
	cmd, err := s.workspaceExecCommandWithEnv(context.Background(), "", "", t.TempDir(),
		[]string{"SAM_WORKSPACE_ID=extra-other-workspace", "GH_TOKEN=extra-stale-token"},
		"git", "-c", "credential.helper=", "-c", "credential.helper="+exchange.helperPath,
		"-c", "credential.useHttpPath=true", "credential", "fill")
	if err != nil {
		t.Fatal(err)
	}
	// Keep git's surrounding test environment hermetic while preserving the
	// production command builder's scoped environment and arguments.
	cmd.Env = withoutTestGitOverrides(cmd.Env)
	cmd.Env = append(cmd.Env, "SAM_GIT_CREDENTIAL_ENDPOINT="+exchange.endpoint, "GIT_TERMINAL_PROMPT=0")
	cmd.Stdin = strings.NewReader("protocol=https\nhost=github.com\npath=owner/repo.git\n\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("runtime git credential exchange failed: %v", err)
	}
	if !bytes.Contains(out, []byte("password=fresh-runtime-token")) {
		t.Fatal("runtime git did not receive the fresh credential")
	}
	if got := exchange.lastRequestQuery().Get("workspaceId"); got != exchange.workspaceID {
		t.Fatalf("credential exchange used wrong workspace: %q", got)
	}
	assertRuntimeCommandHasNoToken(t, cmd.Args, cmd.Env)
}

func TestStandaloneRuntimeGhCommandUsesRefreshShimAndFailsWithoutMint(t *testing.T) {
	for _, tc := range []struct {
		name           string
		mintStatus     int
		inheritedToken string
	}{
		{"fresh exchange", http.StatusOK, "stale-runtime-token"},
		{"refused with inherited token", http.StatusForbidden, "stale-runtime-token"},
		{"refused without inherited token", http.StatusForbidden, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			exchange := newStandaloneCredentialExchange(t, "owned-workspace", tc.mintStatus, "fresh-runtime-token")
			systemBin := writeFakeGh(t, "system-gh")
			var storedEnv []string
			var canary string
			if tc.mintStatus != http.StatusOK {
				systemBin, storedEnv, canary = storedCredentialGh(t)
			}
			shimDir := t.TempDir()
			shimPath := installShim(t, shimDir, exchange.helperPath, pathList(shimDir, systemBin))
			s := &Server{config: &config.Config{Role: config.RoleStandalone, WorkspaceID: exchange.workspaceID}}
			cmd, err := s.workspaceExecCommandWithEnv(context.Background(), "", "", t.TempDir(),
				[]string{"SAM_WORKSPACE_ID=other-workspace", "GH_TOKEN=" + tc.inheritedToken}, "gh", "pr", "list")
			if err != nil {
				t.Fatal(err)
			}
			if cmd.Path != filepath.Join(standaloneGhShimDir, "gh") {
				t.Fatal("runtime gh bypassed trusted refresh shim")
			}
			assertRuntimeCommandHasNoToken(t, cmd.Args, cmd.Env)
			// Substitute only the installed artifact location for the test's
			// production-rendered shim, never production PATH lookup.
			cmd.Path = shimPath
			cmd.Args[0] = shimPath
			cmd.Env = withoutTestGitOverrides(cmd.Env)
			cmd.Env = append(cmd.Env, "SAM_GIT_CREDENTIAL_ENDPOINT="+exchange.endpoint)
			cmd.Env = append(cmd.Env, storedEnv...)
			out, err := cmd.Output()
			if tc.mintStatus == http.StatusOK {
				if err != nil {
					t.Fatalf("runtime gh shim execution failed: %v", err)
				}
				if !bytes.Contains(out, []byte("GH_TOKEN=fresh-runtime-token")) {
					t.Fatal("runtime gh did not receive refreshed credential")
				}
			} else {
				if err == nil {
					t.Fatalf("runtime gh succeeded after mint was refused: %q", out)
				}
				if len(out) != 0 {
					t.Fatalf("runtime gh read stored credentials after mint was refused: %q", out)
				}
				if _, err := os.Stat(canary); !os.IsNotExist(err) {
					t.Fatalf("runtime gh was invoked after refusal: %v", err)
				}
			}
			if exchange.mintCalls.Load() != 1 {
				t.Fatal("runtime gh did not use scoped credential exchange")
			}
		})
	}
}

func TestStandaloneRuntimeGitRefusesMissingLaunchIdentity(t *testing.T) {
	exchange := newStandaloneCredentialExchange(t, "owned-workspace", http.StatusOK, "fresh-runtime-token")
	s := &Server{config: &config.Config{Role: config.RoleStandalone}}
	if _, err := s.workspaceExecCommandWithEnv(context.Background(), "", "", t.TempDir(),
		[]string{"SAM_WORKSPACE_ID=untrusted-workspace"}, "gh", "--version"); err == nil {
		t.Fatal("gh accepted caller identity without launch identity")
	}
	cmd, err := s.workspaceExecCommandWithEnv(context.Background(), "", "", t.TempDir(),
		[]string{"SAM_WORKSPACE_ID=" + exchange.workspaceID}, "git", "-c", "credential.helper=",
		"-c", "credential.helper="+exchange.helperPath, "credential", "fill")
	if err != nil {
		t.Fatal(err)
	}
	cmd.Env = withoutTestGitOverrides(cmd.Env)
	cmd.Env = append(cmd.Env, "SAM_GIT_CREDENTIAL_ENDPOINT="+exchange.endpoint, "GIT_TERMINAL_PROMPT=0")
	cmd.Stdin = strings.NewReader("protocol=https\nhost=github.com\n\n")
	if _, err := cmd.Output(); err == nil {
		t.Fatal("git acquired credentials without launch identity")
	}
	if exchange.mintCalls.Load() != 0 {
		t.Fatal("git minted credentials using untrusted workspace identity")
	}
}

func withoutTestGitOverrides(env []string) []string {
	result := make([]string, 0, len(env))
	for _, entry := range env {
		if !strings.HasPrefix(entry, "GIT_") && !strings.HasPrefix(entry, "SAM_GIT_CREDENTIAL_ENDPOINT=") {
			result = append(result, entry)
		}
	}
	return result
}

func assertRuntimeCommandHasNoToken(t *testing.T, args, env []string) {
	t.Helper()
	for _, entries := range [][]string{args, env} {
		for _, entry := range entries {
			if strings.Contains(entry, "runtime-token") || strings.Contains(entry, "stale-token") || strings.Contains(entry, "stale-other-token") {
				t.Fatal("runtime command retained a credential")
			}
		}
	}
}
