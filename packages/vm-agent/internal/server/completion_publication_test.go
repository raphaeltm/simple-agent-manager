package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

// Both harnesses use makeTaskCompletionCallback, including the final prompt
// sent during actual task completion. Exercise its successful and interrupted
// outcomes against a real repository with a reachable remote.
func TestCompletionNeverPublishesRepository(t *testing.T) {
	for _, role := range []string{config.RoleStandalone, config.RoleWorkspace} {
		for _, mode := range []string{config.TaskModeTask, config.TaskModeConversation} {
			for _, reason := range []string{"end_turn", "max_tokens", "cancelled", "recovered", "checkpoint_preempted"} {
				t.Run(role+"/"+mode+"/"+reason, func(t *testing.T) {
					remote, repo := setupPushGuardRepository(t, "sam/task-output")
					writeAgentChange(t, repo)
					runPushGuardGit(t, repo, "add", "agent-change.txt")
					runPushGuardGit(t, repo, "commit", "-m", "agent-directed local commit")
					if err := os.WriteFile(filepath.Join(repo, "agent-change.txt"), []byte("staged"), 0600); err != nil {
						t.Fatal(err)
					}
					// Preserve separately staged and unstaged content.
					runPushGuardGit(t, repo, "add", "agent-change.txt")
					if err := os.WriteFile(filepath.Join(repo, "agent-change.txt"), []byte("unstaged"), 0600); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(repo, ".do-state.md"), []byte("workflow"), 0600); err != nil {
						t.Fatal(err)
					}
					beforeHead := runPushGuardGit(t, repo, "rev-parse", "HEAD")
					beforeStatus := runPushGuardGit(t, repo, "status", "--porcelain=v1")
					beforeIndex := runPushGuardGit(t, repo, "write-tree")
					beforeRefs := runPushGuardGit(t, remote, "show-ref")
					var body map[string]interface{}
					api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
							t.Error(err)
						}
						w.WriteHeader(http.StatusOK)
					}))
					defer api.Close()
					s := newStandalonePushGuardServer(repo, "sam/task-output")
					s.config.Role = role
					s.workspaces["workspace-1"].CallbackToken = "test-callback"
					s.makeTaskCompletionCallback(api.URL, "project", "task", "workspace-1", mode)(reason, nil)
					if body["executionStep"] != "awaiting_followup" {
						t.Fatalf("callback = %#v", body)
					}
					if got := runPushGuardGit(t, repo, "rev-parse", "HEAD"); got != beforeHead {
						t.Fatal("completion committed work")
					}
					if got := runPushGuardGit(t, repo, "status", "--porcelain=v1"); got != beforeStatus {
						t.Fatal("completion changed worktree/index")
					}
					if got := runPushGuardGit(t, repo, "write-tree"); got != beforeIndex {
						t.Fatal("completion staged work")
					}
					if got := runPushGuardGit(t, remote, "show-ref"); got != beforeRefs {
						t.Fatal("completion pushed work")
					}
					result := body["gitPushResult"].(map[string]interface{})
					if result["pushed"] != false || result["prUrl"] != "" || result["error"] != "" {
						t.Fatalf("unexpected publication: %#v", result)
					}
				})
			}
		}
	}
}
