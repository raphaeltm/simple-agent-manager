package server

import (
	"context"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
)

const cloneIdentityReadme = "cloned through the real bootstrap path\n"

// newGitHTTPRemote serves a bare repository over git's smart HTTP protocol so
// bootstrap performs a real network clone, exactly as it does against GitHub.
func newGitHTTPRemote(t *testing.T) string {
	t.Helper()
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git binary unavailable")
	}
	projects := t.TempDir()
	work := t.TempDir()
	gitEnv := append(os.Environ(),
		"GIT_AUTHOR_NAME=SAM Test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=SAM Test", "GIT_COMMITTER_EMAIL=test@example.com",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command(gitPath, args...)
		cmd.Dir = dir
		cmd.Env = gitEnv
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run(projects, "init", "--bare", "-b", "main", "repo.git")
	run(work, "init", "-b", "main", ".")
	if err := os.WriteFile(filepath.Join(work, "README.md"), []byte(cloneIdentityReadme), 0o644); err != nil {
		t.Fatal(err)
	}
	run(work, "add", "README.md")
	run(work, "commit", "-m", "initial")
	run(work, "push", filepath.Join(projects, "repo.git"), "main")

	srv := httptest.NewServer(&cgi.Handler{
		Path: gitPath,
		Args: []string{"http-backend"},
		Env:  []string{"GIT_PROJECT_ROOT=" + projects, "GIT_HTTP_EXPORT_ALL=1"},
	})
	t.Cleanup(srv.Close)
	return srv.URL + "/repo.git"
}

func rootIdentity(t *testing.T, info os.FileInfo) (uint64, uint64) {
	t.Helper()
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("filesystem identity unavailable")
	}
	return uint64(st.Dev), st.Ino
}

// Regression for production nodes where every automatic deletion of a freshly
// cloned VM workspace returned 409 "host workspace root ownership is unproven":
// provisioning recorded the owned root's inode, then bootstrap replaced the
// directory before cloning. This drives the real provisioning entry point, the
// real bootstrap clone over HTTP, and the real physical-deletion handler.
func TestFreshlyClonedWorkspaceRootRemainsDeletable(t *testing.T) {
	for _, tc := range []struct {
		name string
		// leftovers simulates a prior partial clone that bootstrap must clear.
		leftovers bool
	}{
		{name: "fresh owned root"},
		{name: "owned root with partial clone leftovers", leftovers: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repoURL := newGitHTTPRemote(t)
			f := newDeletionFixture(t)
			// The fixture pre-creates the root; provisioning must create and record it itself.
			if err := os.RemoveAll(f.root); err != nil {
				t.Fatal(err)
			}
			if err := f.server.store.DeleteOwnedWorkspaceRoot("workspace-1"); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(filepath.Join(f.state, "fail-volume")); err != nil {
				t.Fatal(err)
			}

			controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/workspaces/workspace-1/git-token":
					_, _ = w.Write([]byte(`{"token":"ghs_test","expiresAt":"2099-12-31T00:00:00Z"}`))
				case "/api/workspaces/workspace-1/runtime-assets":
					_, _ = w.Write([]byte(`{"workspaceId":"workspace-1","envVars":[],"files":[]}`))
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			t.Cleanup(controlPlane.Close)
			f.server.config.ControlPlaneURL = controlPlane.URL
			// Bounds the post-clone devcontainer wait, which cannot succeed here.
			f.server.config.BootstrapTimeout = 5 * time.Second

			// Register the runtime the way workspace creation does; root, container
			// label and generation hydrate from the persisted workspace metadata.
			runtime := f.server.upsertWorkspaceRuntime("workspace-1", repoURL, "main", "creating", "callback-token",
				workspaceRuntimeOpts{CloneURL: repoURL})
			if runtime.WorkspaceDir != f.root || runtime.EvictionGeneration != "generation-1" {
				t.Fatalf("runtime did not hydrate fixture metadata: dir=%q generation=%q", runtime.WorkspaceDir, runtime.EvictionGeneration)
			}

			original := prepareWorkspaceForRuntime
			t.Cleanup(func() { prepareWorkspaceForRuntime = original })
			var pinned *os.File
			var prepareCalled bool
			prepareWorkspaceForRuntime = func(ctx context.Context, cfg *config.Config, state bootstrap.ProvisionState, reporter *bootlog.Reporter) (bool, error) {
				prepareCalled = true
				// Provisioning has created and recorded the owned root by now. Holding
				// it open stops the filesystem reusing its inode number, so a replaced
				// directory is always observable instead of passing by coincidence.
				var err error
				if pinned, err = os.Open(cfg.WorkspaceDir); err != nil {
					t.Fatalf("owned root missing before bootstrap: %v", err)
				}
				if tc.leftovers {
					if err := os.WriteFile(filepath.Join(cfg.WorkspaceDir, "partial.pack"), []byte("junk"), 0o600); err != nil {
						t.Fatal(err)
					}
					if err := os.Mkdir(filepath.Join(cfg.WorkspaceDir, "half-checkout"), 0o755); err != nil {
						t.Fatal(err)
					}
				}
				// The real bootstrap: clones, then fails at the devcontainer step in
				// this harness (no devcontainer CLI). The clone is what matters here.
				return original(ctx, cfg, state, reporter)
			}

			_, _ = f.server.provisionWorkspaceRuntime(t.Context(), runtime)
			if !prepareCalled || pinned == nil {
				t.Fatal("real bootstrap was never reached")
			}
			t.Cleanup(func() { _ = pinned.Close() })

			// Liveness: the clone really happened into the owned root.
			readme, err := os.ReadFile(filepath.Join(f.root, "README.md"))
			if err != nil || string(readme) != cloneIdentityReadme {
				t.Fatalf("repository was not cloned into the owned root: %q %v", readme, err)
			}
			if tc.leftovers {
				for _, junk := range []string{"partial.pack", "half-checkout"} {
					if _, err := os.Lstat(filepath.Join(f.root, junk)); !os.IsNotExist(err) {
						t.Fatalf("partial clone leftover %s survived: %v", junk, err)
					}
				}
			}

			pinnedInfo, err := pinned.Stat()
			if err != nil {
				t.Fatal(err)
			}
			currentInfo, err := os.Lstat(f.root)
			if err != nil {
				t.Fatal(err)
			}
			pinnedDev, pinnedIno := rootIdentity(t, pinnedInfo)
			currentDev, currentIno := rootIdentity(t, currentInfo)
			if pinnedDev != currentDev || pinnedIno != currentIno {
				t.Fatalf("bootstrap replaced the SAM-owned root: recorded %d/%d, now %d/%d", pinnedDev, pinnedIno, currentDev, currentIno)
			}

			// The control plane's automatic deletion must now be accepted.
			rec := f.request(t.Context(), workspaceDeletionRequest{
				workspaceDeletionIdentity: f.identity,
				DeletionMode:              "automatic",
				PreservationExpiresAt:     time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
			})
			if rec.Code != http.StatusOK {
				t.Fatalf("automatic deletion of cloned workspace = %d %s", rec.Code, strings.TrimSpace(rec.Body.String()))
			}
			if _, err := os.Lstat(f.root); !os.IsNotExist(err) {
				t.Fatalf("owned root survived deletion: %v", err)
			}
		})
	}
}
