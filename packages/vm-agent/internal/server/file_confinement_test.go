package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
)

// Working-tree confinement, through the real handlers and real commands against a real
// filesystem (the standalone runtime runs them directly, as on an Instant container). A
// teammate's request carries ?confine=workdir; the owner's carries nothing and is unchanged.

const confinementWorkspaceID = "WS_CONFINE"

type confinementFixture struct {
	handler http.Handler
	cookie  string
	repo    string
}

func newConfinementFixture(t *testing.T) confinementFixture {
	t.Helper()
	for _, bin := range []string{"/usr/bin/realpath", "/usr/bin/git", "/usr/bin/find", "/usr/bin/stat", "/usr/bin/cat"} {
		if _, err := os.Stat(bin); err != nil {
			t.Skipf("%s is required: %v", bin, err)
		}
	}
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	outside := filepath.Join(root, "outside")
	for _, dir := range []string{filepath.Join(repo, "sub"), outside} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path, content string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	link := func(target, path string) {
		t.Helper()
		if err := os.Symlink(target, path); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(repo, "README.md"), "hello from the repo\n")
	write(filepath.Join(repo, "sub", "ok.txt"), "inside\n")
	write(filepath.Join(outside, "secret.txt"), "outside secret\n")
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("/usr/bin/git", append([]string{"-c", "user.email=t@example.com", "-c", "user.name=T"}, args...)...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init", "-q")
	git("add", "README.md", "sub/ok.txt")
	git("commit", "-q", "-m", "init")
	write(filepath.Join(repo, ".git", "sam-test-marker"), "inside .git\n")
	// Links the agent could have made, committed or not.
	link(filepath.Join(outside, "secret.txt"), filepath.Join(repo, "abs-link"))
	link("../outside/secret.txt", filepath.Join(repo, "rel-link"))
	link("../outside", filepath.Join(repo, "dir-link"))
	link("sub/ok.txt", filepath.Join(repo, "inside-link"))

	sm := auth.NewSessionManager("session", false, time.Hour)
	sess, err := sm.CreateSession(&auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{Subject: "owner"},
		Workspace:        confinementWorkspaceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		config: &config.Config{
			Role:                 config.RoleStandalone,
			WorkspaceDir:         repo,
			GitExecTimeout:       10 * time.Second,
			GitFileMaxSize:       1 << 20,
			FileListTimeout:      10 * time.Second,
			FileListMaxEntries:   1000,
			FileFindTimeout:      10 * time.Second,
			FileFindMaxEntries:   1000,
			FileRawMaxSize:       1 << 20,
			FileRawTimeout:       10 * time.Second,
			FileDownloadTimeout:  10 * time.Second,
			FileDownloadMaxBytes: 1 << 20,
		},
		sessionManager:  sm,
		workspaces:      map[string]*WorkspaceRuntime{},
		workspaceEvents: map[string][]EventRecord{},
	}
	s.workspaces[confinementWorkspaceID] = &WorkspaceRuntime{
		ID:               confinementWorkspaceID,
		Status:           "running",
		ContainerWorkDir: repo,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /workspaces/{workspaceId}/git/status", s.handleGitStatus)
	mux.HandleFunc("GET /workspaces/{workspaceId}/git/diff", s.handleGitDiff)
	mux.HandleFunc("GET /workspaces/{workspaceId}/git/file", s.handleGitFile)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/list", s.handleFileList)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/find", s.handleFileFind)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/raw", s.handleFileRaw)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/download", s.handleFileDownload)
	return confinementFixture{handler: mux, cookie: sess.ID, repo: repo}
}

func (f confinementFixture) get(t *testing.T, endpoint string, params map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	query := url.Values{}
	for key, value := range params {
		query.Set(key, value)
	}
	req := httptest.NewRequest(http.MethodGet,
		"/workspaces/"+confinementWorkspaceID+"/"+endpoint+"?"+query.Encode(), nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
	rec := httptest.NewRecorder()
	f.handler.ServeHTTP(rec, req)
	return rec
}

func confined(params map[string]string) map[string]string {
	out := map[string]string{pathConfinementParam: pathConfinementWorkDir}
	for key, value := range params {
		out[key] = value
	}
	return out
}

func bodyOf(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	data, err := io.ReadAll(rec.Result().Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// Every read endpoint refuses each way out of the working tree, and says nothing about what
// lies beyond it.
func TestConfinedReadsRefuseEveryPathOutOfTheWorkingTree(t *testing.T) {
	f := newConfinementFixture(t)
	escapes := map[string]string{
		"absolute path":               "/etc/hostname",
		"home-relative path":          "~/.bashrc",
		"symlink to an absolute file": "abs-link",
		"symlink to a relative file":  "rel-link",
		"through a symlinked dir":     "dir-link/secret.txt",
		"inside .git":                 ".git/sam-test-marker",
		"the .git directory itself":   ".git",
	}
	for _, endpoint := range []string{"files/raw", "files/download", "git/file"} {
		for name, path := range escapes {
			t.Run(endpoint+"/"+name, func(t *testing.T) {
				rec := f.get(t, endpoint, confined(map[string]string{"path": path}))
				if rec.Code == http.StatusOK {
					t.Fatalf("%s %q was served: %s", endpoint, path, bodyOf(t, rec))
				}
				if body := bodyOf(t, rec); strings.Contains(body, "outside secret") || strings.Contains(body, "inside .git") {
					t.Fatalf("%s %q leaked content: %s", endpoint, path, body)
				}
				if got := rec.Header().Get(pathConfinementHeader); got != pathConfinementWorkDir {
					t.Fatalf("%s did not confirm confinement (header %q)", endpoint, got)
				}
			})
		}
	}
	for name, path := range map[string]string{
		"absolute dir":           "/etc",
		"symlinked dir":          "dir-link",
		"symlinked dir, slashed": "dir-link/",
		".git":                   ".git",
	} {
		t.Run("files/list/"+name, func(t *testing.T) {
			rec := f.get(t, "files/list", confined(map[string]string{"path": path}))
			if rec.Code == http.StatusOK {
				t.Fatalf("listing %q was served: %s", path, bodyOf(t, rec))
			}
		})
	}
}

// Control: the same endpoints serve the working tree, including a symlink that stays inside.
func TestConfinedReadsServeTheWorkingTree(t *testing.T) {
	f := newConfinementFixture(t)
	for _, endpoint := range []string{"files/raw", "files/download"} {
		for path, want := range map[string]string{"README.md": "hello from the repo", "sub/ok.txt": "inside", "inside-link": "inside"} {
			rec := f.get(t, endpoint, confined(map[string]string{"path": path}))
			if rec.Code != http.StatusOK || !strings.Contains(bodyOf(t, rec), want) {
				t.Fatalf("%s %q: status %d body %q", endpoint, path, rec.Code, bodyOf(t, rec))
			}
			if rec.Header().Get(pathConfinementHeader) != pathConfinementWorkDir {
				t.Fatalf("%s did not confirm confinement", endpoint)
			}
		}
	}
	file := f.get(t, "git/file", confined(map[string]string{"path": "sub/ok.txt"}))
	if file.Code != http.StatusOK || !strings.Contains(bodyOf(t, file), "inside") {
		t.Fatalf("git/file: %d %s", file.Code, bodyOf(t, file))
	}
	committed := f.get(t, "git/file", confined(map[string]string{"path": "README.md", "ref": "HEAD"}))
	if committed.Code != http.StatusOK || !strings.Contains(bodyOf(t, committed), "hello from the repo") {
		t.Fatalf("git/file at HEAD: %d %s", committed.Code, bodyOf(t, committed))
	}
	// A teammate sees exactly the listing the owner sees inside the tree.
	names := func(rec *httptest.ResponseRecorder) []string {
		t.Helper()
		var listing FileListResponse
		if err := json.Unmarshal([]byte(bodyOf(t, rec)), &listing); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("files/list: %d %v", rec.Code, err)
		}
		out := make([]string, 0, len(listing.Entries))
		for _, entry := range listing.Entries {
			out = append(out, entry.Type+":"+entry.Name)
		}
		return out
	}
	teammateSub := names(f.get(t, "files/list", confined(map[string]string{"path": "sub"})))
	ownerSub := names(f.get(t, "files/list", map[string]string{"path": "sub"}))
	if strings.Join(teammateSub, ",") != strings.Join(ownerSub, ",") || !strings.Contains(strings.Join(teammateSub, ","), "file:ok.txt") {
		t.Fatalf("files/list sub: teammate %v, owner %v", teammateSub, ownerSub)
	}
	root := f.get(t, "files/list", confined(nil))
	if root.Code != http.StatusOK || root.Header().Get(pathConfinementHeader) != pathConfinementWorkDir {
		t.Fatalf("files/list root: %d", root.Code)
	}
	for _, endpoint := range []string{"files/find", "git/status"} {
		rec := f.get(t, endpoint, confined(nil))
		if rec.Code != http.StatusOK || rec.Header().Get(pathConfinementHeader) != pathConfinementWorkDir {
			t.Fatalf("%s: %d header %q", endpoint, rec.Code, rec.Header().Get(pathConfinementHeader))
		}
		if strings.Contains(bodyOf(t, rec), "secret") {
			t.Fatalf("%s listed something outside the tree", endpoint)
		}
	}
}

// The untracked fallback in git/diff cats the file, which follows symlinks.
func TestConfinedGitDiffDoesNotCatAnUntrackedSymlinkOut(t *testing.T) {
	f := newConfinementFixture(t)
	rec := f.get(t, "git/diff", confined(map[string]string{"path": "rel-link"}))
	if strings.Contains(bodyOf(t, rec), "outside secret") {
		t.Fatalf("git/diff followed an untracked symlink out of the tree: %s", bodyOf(t, rec))
	}
	if rec.Header().Get(pathConfinementHeader) != pathConfinementWorkDir {
		t.Fatal("git/diff did not confirm confinement")
	}
	// Control: an untracked file inside the tree still shows as all additions.
	if err := os.WriteFile(filepath.Join(f.repo, "new.txt"), []byte("brand new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	inside := f.get(t, "git/diff", confined(map[string]string{"path": "new.txt"}))
	if inside.Code != http.StatusOK || !strings.Contains(bodyOf(t, inside), "+brand new") {
		t.Fatalf("git/diff of an untracked file: %d %s", inside.Code, bodyOf(t, inside))
	}
	absolute := f.get(t, "git/diff", confined(map[string]string{"path": "/etc/hostname"}))
	if absolute.Code == http.StatusOK {
		t.Fatalf("git/diff served an absolute path: %s", bodyOf(t, absolute))
	}
}

// The owner's requests carry no confine parameter: unchanged, and not marked as confined.
func TestUnconfinedReadsAreUnchangedForTheOwner(t *testing.T) {
	f := newConfinementFixture(t)
	rec := f.get(t, "files/raw", map[string]string{"path": "dir-link/secret.txt"})
	if rec.Code != http.StatusOK || !strings.Contains(bodyOf(t, rec), "outside secret") {
		t.Fatalf("owner read through a symlinked dir: %d %s", rec.Code, bodyOf(t, rec))
	}
	if rec.Header().Get(pathConfinementHeader) != "" {
		t.Fatal("an unconfined response must not claim confinement")
	}
	file := f.get(t, "git/file", map[string]string{"path": "abs-link"})
	if file.Code != http.StatusOK || !strings.Contains(bodyOf(t, file), "outside secret") {
		t.Fatalf("owner git/file through a symlink: %d %s", file.Code, bodyOf(t, file))
	}
}

func TestUnknownConfinementIsRefused(t *testing.T) {
	f := newConfinementFixture(t)
	for _, endpoint := range []string{"files/raw", "files/list", "files/find", "git/status", "git/file", "git/diff", "files/download"} {
		rec := f.get(t, endpoint, map[string]string{pathConfinementParam: "everything", "path": "README.md"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s accepted an unknown confine value: %d", endpoint, rec.Code)
		}
	}
}

func TestConfineResolvedPath(t *testing.T) {
	cases := []struct {
		root, target string
		ok           bool
	}{
		{"/w/repo", "/w/repo", true},
		{"/w/repo", "/w/repo/a/b", true},
		{"/w/repo", "/w/repo-other/x", false},
		{"/w/repo", "/w", false},
		{"/w/repo", "/w/repo/.git", false},
		{"/w/repo", "/w/repo/.git/config", false},
		{"/w/repo", "/w/repo/.gitignore", true},
		{"/", "/etc/passwd", false},
		{"relative", "/w/repo", false},
	}
	for _, tc := range cases {
		_, err := confineResolvedPath(tc.root, tc.target)
		if (err == nil) != tc.ok {
			t.Errorf("confineResolvedPath(%q, %q) err=%v, want ok=%v", tc.root, tc.target, err, tc.ok)
		}
	}
}

func TestSanitizeConfinedPath(t *testing.T) {
	for path, want := range map[string]string{"README.md": "./README.md", "sub/ok.txt": "./sub/ok.txt", ".": ".", "-n": "./-n"} {
		got, err := sanitizeConfinedPath(path)
		if err != nil || got != want {
			t.Errorf("sanitizeConfinedPath(%q) = %q, %v; want %q", path, got, err, want)
		}
	}
	for _, path := range []string{"/etc/passwd", "~/.ssh/id_rsa", "~", "../x", "a/../../x", "a\nb", "a\rb", ""} {
		if _, err := sanitizeConfinedPath(path); err == nil {
			t.Errorf("sanitizeConfinedPath(%q) accepted a path out of the working tree", path)
		}
	}
}

// The VM runtime runs the same resolution through docker exec, in the workspace's devcontainer,
// as its user and from its working directory. The command must reach the container unchanged.
func TestConfinedResolutionRunsInsideTheDevcontainer(t *testing.T) {
	s := &Server{config: &config.Config{ContainerMode: true}}
	cmd, err := s.workspaceExecCommand(context.Background(), "abc123", "node", "/workspaces/repo", "realpath", ".", "./README.md")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{dockerBinaryPath, "exec", "-i", "-u", "node", "-w", "/workspaces/repo", "abc123", "realpath", ".", "./README.md"}
	if strings.Join(cmd.Args, " ") != strings.Join(want, " ") {
		t.Fatalf("docker exec args = %q, want %q", cmd.Args, want)
	}
}
