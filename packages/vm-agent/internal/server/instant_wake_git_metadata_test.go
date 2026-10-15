package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

// Cold Instant boot retains the checkout branch, but its ephemeral SQLite no
// longer has DefaultBranch. Authenticated workspace hydration must refresh a
// running standalone workspace before the restored session resumes.
func TestInstantColdWakeMetadataHydrationRestoresDefaultBranch(t *testing.T) {
	for _, branch := range []string{"sam/restored-task", "main"} {
		t.Run(branch, func(t *testing.T) {
			remote, workDir := setupPushGuardRepository(t, branch)
			mainBefore := runPushGuardGit(t, remote, "rev-parse", "refs/heads/main")
			s, _ := newRestoreRetryTestServer(t)
			if err := s.store.SetCallbackTokenEncryptionSecret("test-node-encryption-secret"); err != nil {
				t.Fatal(err)
			}
			s.config.Role = config.RoleStandalone
			s.config.WorkspaceID = "ws"
			s.config.WorkspaceDir = workDir
			s.config.ContainerWorkDir = workDir
			s.config.WorkspaceReadyCallbackTimeout = time.Second
			controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
			}))
			defer controlPlane.Close()
			s.config.ControlPlaneURL = controlPlane.URL
			runtime := s.workspaces["ws"]
			runtime.Repository = "owner/repo"
			runtime.ChatSessionID = "chat"
			runtime.Branch = branch
			runtime.WorkspaceDir = workDir
			runtime.ContainerWorkDir = workDir
			runtime.Lightweight = true
			validator, key := newWorkspaceCreateJWTValidator(t, "node-test")
			s.jwtValidator = validator
			token := signWorkspaceCreateNodeToken(t, key, "node-test", "ws")
			body, err := json.Marshal(createWorkspaceRequest{
				WorkspaceID: "ws", Repository: "owner/repo", Branch: branch,
				DefaultBranch: "main", BaseBranch: "main", Lightweight: true,
				ProjectID: "project", TaskID: "original-task", CallbackToken: "fresh-callback",
			})
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/workspaces", strings.NewReader(string(body)))
			request.Header.Set("Authorization", "Bearer "+token)
			request.Header.Set("X-SAM-Workspace-Id", "ws")
			response := httptest.NewRecorder()
			s.handleCreateWorkspace(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("running standalone metadata hydration status = %d", response.Code)
			}
			if got := s.workspaces["ws"].DefaultBranch; got != "main" {
				t.Fatalf("canonical default branch was not restored: %q", got)
			}
			metadata, err := s.store.GetWorkspaceMetadata("ws")
			if err != nil || metadata == nil || metadata.DefaultBranch != "main" {
				t.Fatalf("canonical branch metadata was not persisted: %v", err)
			}
			if runtime.ProjectID != "project" || runtime.ChatSessionID != "chat" || runtime.TaskID != "original-task" {
				t.Fatal("workspace hydration lost original session/task routing")
			}
			if got := runPushGuardGit(t, remote, "rev-parse", "refs/heads/main"); got != mainBefore {
				t.Fatal("restored completion changed the repository default branch")
			}
		})
	}
}
