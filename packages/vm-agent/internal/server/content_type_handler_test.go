package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
)

// newFileHandlerTestServer builds a standalone-mode Server whose file endpoints
// exec directly against a real temp directory on the host (no Docker), with a
// valid unscoped session cookie for auth. Returns the server, the workspace ID,
// the temp dir, and the session cookie value.
func newFileHandlerTestServer(t *testing.T) (srv *Server, workspaceID, tmpDir, sessionID string) {
	t.Helper()
	tmpDir = t.TempDir()

	cfg := &config.Config{
		Role:                 config.RoleStandalone,
		AllowedOrigins:       []string{"*"},
		WorkspaceDir:         tmpDir,
		FileRawTimeout:       60 * time.Second,
		FileRawMaxSize:       50 * 1024 * 1024,
		FileDownloadTimeout:  60 * time.Second,
		FileDownloadMaxBytes: 50 * 1024 * 1024,
	}

	sm := auth.NewSessionManager("session", false, time.Hour)
	sess, err := sm.CreateSession(&auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{Subject: "test-user"},
	})
	if err != nil {
		t.Fatalf("create auth session: %v", err)
	}

	workspaceID = "ws-content-type-test"
	srv = &Server{
		config:         cfg,
		sessionManager: sm,
		done:           make(chan struct{}),
		workspaces: map[string]*WorkspaceRuntime{
			workspaceID: {ID: workspaceID, Status: "running", WorkspaceDir: tmpDir},
		},
	}
	return srv, workspaceID, tmpDir, sess.ID
}

// TestFileHandlersUseResolveContentType proves the WIRING the bug lived in: that
// BOTH file-serving handlers (handleFileRaw and handleFileDownload — the latter
// is the upload_to_library path) derive their response Content-Type via
// resolveContentType, not a direct mime.TypeByExtension call.
//
// It stubs mimeTypeByExtension with a SENTINEL value. The fixed handlers route
// through resolveContentType, which consults mimeTypeByExtension, so they emit
// the sentinel. A regression that reverts a handler to calling mime.TypeByExtension
// directly (the exact shape of the original bug) bypasses the stub and emits the
// host's real type, failing this test — which is why it is discriminating on a
// dev/CI host that has a mime database. Runs in standalone mode against a real
// temp file, so no Docker/container exec is required.
func TestFileHandlersUseResolveContentType(t *testing.T) {
	const sentinel = "application/x-sam-content-type-sentinel"
	orig := mimeTypeByExtension
	mimeTypeByExtension = func(string) string { return sentinel }
	t.Cleanup(func() { mimeTypeByExtension = orig })

	srv, workspaceID, tmpDir, sessionID := newFileHandlerTestServer(t)
	if err := os.WriteFile(filepath.Join(tmpDir, "notes.md"), []byte("# recovered\n"), 0o644); err != nil {
		t.Fatalf("write temp file: %v", err)
	}

	cases := []struct {
		name        string
		handler     func(http.ResponseWriter, *http.Request)
		path        string
		wantNosniff bool
	}{
		{
			name:        "files/raw",
			handler:     srv.handleFileRaw,
			path:        "/workspaces/" + workspaceID + "/files/raw?path=notes.md",
			wantNosniff: true,
		},
		{
			name:    "files/download",
			handler: srv.handleFileDownload,
			path:    "/workspaces/" + workspaceID + "/files/download?path=notes.md",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req.SetPathValue("workspaceId", workspaceID)
			req.AddCookie(&http.Cookie{Name: "session", Value: sessionID})
			rec := httptest.NewRecorder()

			tc.handler(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%q", rec.Code, rec.Body.String())
			}
			if got := rec.Header().Get("Content-Type"); got != sentinel {
				t.Errorf("Content-Type = %q, want %q — handler must derive it via resolveContentType", got, sentinel)
			}
			if tc.wantNosniff && rec.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Errorf("X-Content-Type-Options = %q, want %q", rec.Header().Get("X-Content-Type-Options"), "nosniff")
			}
		})
	}
}
