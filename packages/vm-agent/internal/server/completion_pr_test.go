package server

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

// Completion pushes the named task branch; GitHub rejects literal HEAD as a
// head ref. Exercise the PR flow and both runtime command boundaries.
func TestCompletionPRUsesPushedBranchAndRetainsExistingPRFallback(t *testing.T) {
	for _, standalone := range []bool{false, true} {
		for _, existing := range []bool{false, true} {
			name := "VM"
			if standalone {
				name = "Instant"
			}
			if existing {
				name += "/existing"
			}
			t.Run(name, func(t *testing.T) {
				cfg := &config.Config{WorkspaceID: "owned-workspace", ContainerMode: true}
				if standalone {
					cfg.Role = config.RoleStandalone
				}
				s := &Server{config: cfg}
				branch := "sam/restored-task-output"
				calls := 0
				run := func(ctx context.Context, containerID, user, workDir string, args ...string) (string, string, error) {
					calls++
					cmd, err := s.workspaceExecCommand(ctx, containerID, user, workDir, args...)
					if err != nil {
						t.Fatal(err)
					}
					if calls == 1 {
						want := []string{"gh", "pr", "create", "--fill", "--head", branch}
						if !reflect.DeepEqual(args, want) {
							t.Fatalf("completion PR arguments = %q, want %q", args, want)
						}
						if standalone && cmd.Path != standaloneGhShimDir+"/gh" {
							t.Fatal("Instant completion bypassed scoped credential shim")
						}
						if !standalone && cmd.Path != dockerBinaryPath {
							t.Fatal("VM completion bypassed container execution")
						}
						if existing {
							return "", "a pull request already exists", errors.New("exit 1")
						}
						return "https://github.com/owner/repo/pull/123", "", nil
					}
					if !existing || !reflect.DeepEqual(args, []string{"gh", "pr", "view", "--json", "url,number", "--jq", ".url"}) {
						t.Fatalf("unexpected PR fallback arguments: %q", args)
					}
					return "https://github.com/owner/repo/pull/123", "", nil
				}
				prURL, _ := s.tryCreatePRWithExec("container", "/workspaces/repo", "node", branch, run)
				if prURL != "https://github.com/owner/repo/pull/123" {
					t.Fatalf("completion did not return created/existing PR: %q", prURL)
				}
				wantCalls := 1
				if existing {
					wantCalls = 2
				}
				if calls != wantCalls {
					t.Fatalf("PR command count = %d, want %d", calls, wantCalls)
				}
			})
		}
	}
}
