package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
)

// Working-tree confinement, through the real handlers and real commands against a real
// filesystem. A teammate's request carries ?confine=workdir; the owner's carries nothing and is
// unchanged. Each behavioral test runs on both runtimes: standalone runs the commands directly,
// as on an Instant container; devcontainer runs them through docker exec, as on a VM, with a
// docker CLI double whose "container" is this machine.

const (
	confinementWorkspaceID = "WS_CONFINE"
	confinementContainerID = "0123456789ab"
)

type confinementRuntime string

const (
	confinementStandalone   confinementRuntime = "standalone"
	confinementDevcontainer confinementRuntime = "devcontainer"
)

type confinementFixture struct {
	handler http.Handler
	cookie  string
	repo    string
	// dockerCalls lists the docker CLI invocations, one per line; nil on standalone.
	dockerCalls func() []string
}

// fakeDevcontainerDockerCLI stands in for the docker CLI on a VM. It finds one running
// devcontainer, and docker exec runs the command on this machine from the -w directory. Every
// call is logged.
func fakeDevcontainerDockerCLI(t *testing.T) (string, func() []string) {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	path := filepath.Join(dir, "docker")
	script := `#!/bin/sh
printf '%s\n' "$*" >> '` + logPath + `'
case "$1" in
  ps) printf '%s\t%s\n' '` + confinementContainerID + `' '2026-10-20 00:00:00 +0000 UTC'; exit 0 ;;
  inspect) echo true; exit 0 ;;
  exec) shift ;;
  *) echo "unexpected docker command: $1" >&2; exit 64 ;;
esac
workdir=
while [ $# -gt 0 ]; do
  case "$1" in
    -i) shift ;;
    -e|-u) shift 2 ;;
    -w) workdir=$2; shift 2 ;;
    *) break ;;
  esac
done
[ "$1" = '` + confinementContainerID + `' ] || { echo "unexpected container: $1" >&2; exit 65; }
shift
cd "$workdir" || exit 66
exec "$@"
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path, func() []string {
		data, err := os.ReadFile(logPath)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			t.Fatal(err)
		}
		return strings.Split(strings.TrimSpace(string(data)), "\n")
	}
}

func newConfinementFixture(t *testing.T, runtime confinementRuntime) confinementFixture {
	t.Helper()
	for _, bin := range []string{"/usr/bin/realpath", "/usr/bin/git", "/usr/bin/find", "/usr/bin/stat", "/usr/bin/cat", "/bin/sh"} {
		if _, err := os.Stat(bin); err != nil {
			t.Skipf("%s is required: %v", bin, err)
		}
	}
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	outside := filepath.Join(root, "outside")
	for _, dir := range []string{filepath.Join(repo, "sub"), filepath.Join(repo, "vendor", "lib", ".git"), outside} {
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
	// A vendored repository's own .git, which can hold a remote with a token in it.
	write(filepath.Join(repo, "vendor", "lib", ".git", "config"), "inside .git: nested remote token\n")
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
	cfg := &config.Config{
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
	}
	workspace := &WorkspaceRuntime{
		ID:               confinementWorkspaceID,
		Status:           "running",
		ContainerWorkDir: repo,
	}
	fixture := confinementFixture{cookie: sess.ID, repo: repo}
	switch runtime {
	case confinementStandalone:
		cfg.Role = config.RoleStandalone
	case confinementDevcontainer:
		dockerPath, calls := fakeDevcontainerDockerCLI(t)
		previous := dockerBinaryPath
		dockerBinaryPath = dockerPath
		t.Cleanup(func() { dockerBinaryPath = previous })
		t.Setenv("SAM_DOCKER_CLI_PATH", dockerPath)
		cfg.Role = config.RoleWorkspace
		cfg.ContainerMode = true
		cfg.ContainerLabelKey = "devcontainer.local_folder"
		cfg.ContainerCacheTTL = time.Minute
		workspace.ContainerLabelValue = "confine-test"
		workspace.ContainerUser = "node"
		fixture.dockerCalls = calls
	default:
		t.Fatalf("unknown runtime %q", runtime)
	}
	s := &Server{
		config:          cfg,
		sessionManager:  sm,
		workspaces:      map[string]*WorkspaceRuntime{confinementWorkspaceID: workspace},
		workspaceEvents: map[string][]EventRecord{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /workspaces/{workspaceId}/git/status", s.handleGitStatus)
	mux.HandleFunc("GET /workspaces/{workspaceId}/git/diff", s.handleGitDiff)
	mux.HandleFunc("GET /workspaces/{workspaceId}/git/file", s.handleGitFile)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/list", s.handleFileList)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/find", s.handleFileFind)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/raw", s.handleFileRaw)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/download", s.handleFileDownload)
	fixture.handler = mux
	return fixture
}

// forEachConfinementRuntime runs a test on both runtimes. On the devcontainer runtime it also
// checks the requests went through docker exec, so a test cannot pass by never reaching it.
func forEachConfinementRuntime(t *testing.T, test func(t *testing.T, f confinementFixture)) {
	t.Helper()
	for _, runtime := range []confinementRuntime{confinementStandalone, confinementDevcontainer} {
		t.Run(string(runtime), func(t *testing.T) {
			f := newConfinementFixture(t, runtime)
			test(t, f)
			if f.dockerCalls != nil && !slices.ContainsFunc(f.dockerCalls(), func(call string) bool {
				return strings.HasPrefix(call, "exec ")
			}) {
				t.Fatal("no request reached docker exec")
			}
		})
	}
}

func (f confinementFixture) get(t *testing.T, endpoint string, params map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	return f.request(t, endpoint, params, nil)
}

func (f confinementFixture) request(t *testing.T, endpoint string, params, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	query := url.Values{}
	for key, value := range params {
		query.Set(key, value)
	}
	req := httptest.NewRequest(http.MethodGet,
		"/workspaces/"+confinementWorkspaceID+"/"+endpoint+"?"+query.Encode(), nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
	for key, value := range headers {
		req.Header.Set(key, value)
	}
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

// Every read endpoint refuses each way out of the working tree the same way, as not found, and
// says nothing about what lies beyond it.
func TestConfinedReadsRefuseEveryPathOutOfTheWorkingTree(t *testing.T) {
	forEachConfinementRuntime(t, func(t *testing.T, f confinementFixture) {
		escapes := map[string]string{
			"absolute path":               "/etc/hostname",
			"home-relative path":          "~/.bashrc",
			"traversal":                   "../outside/secret.txt",
			"symlink to an absolute file": "abs-link",
			"symlink to a relative file":  "rel-link",
			"through a symlinked dir":     "dir-link/secret.txt",
			"inside .git":                 ".git/sam-test-marker",
			"the .git directory itself":   ".git",
			"inside a nested .git":        "vendor/lib/.git/config",
		}
		for _, endpoint := range []string{"files/raw", "files/download", "git/file"} {
			for name, path := range escapes {
				t.Run(endpoint+"/"+name, func(t *testing.T) {
					rec := f.get(t, endpoint, confined(map[string]string{"path": path}))
					body := bodyOf(t, rec)
					if rec.Code != http.StatusNotFound {
						t.Fatalf("%s %q: status %d, want 404: %s", endpoint, path, rec.Code, body)
					}
					if strings.Contains(body, "outside secret") || strings.Contains(body, "inside .git") {
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
			"traversal":              "../outside",
			"symlinked dir":          "dir-link",
			"symlinked dir, slashed": "dir-link/",
			".git":                   ".git",
			"a nested .git":          "vendor/lib/.git",
		} {
			t.Run("files/list/"+name, func(t *testing.T) {
				rec := f.get(t, "files/list", confined(map[string]string{"path": path}))
				if rec.Code != http.StatusNotFound {
					t.Fatalf("listing %q: status %d, want 404: %s", path, rec.Code, bodyOf(t, rec))
				}
			})
		}
	})
}

// Control: the same endpoints serve the working tree, including a symlink that stays inside.
func TestConfinedReadsServeTheWorkingTree(t *testing.T) {
	forEachConfinementRuntime(t, func(t *testing.T, f confinementFixture) {
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
		// A vendored folder lists normally; only its .git is refused.
		vendor := names(f.get(t, "files/list", confined(map[string]string{"path": "vendor/lib"})))
		if !strings.Contains(strings.Join(vendor, ","), ".git") {
			t.Fatalf("files/list vendor/lib: %v", vendor)
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
	})
}

// A cached confined read answers 304 and still confirms the confinement, so the control plane
// can tell a confined 304 from an old agent's.
func TestConfinedNotModifiedKeepsTheConfinementHeader(t *testing.T) {
	forEachConfinementRuntime(t, func(t *testing.T, f confinementFixture) {
		first := f.get(t, "files/raw", confined(map[string]string{"path": "README.md"}))
		etag := first.Header().Get("ETag")
		if first.Code != http.StatusOK || etag == "" {
			t.Fatalf("files/raw: %d etag %q", first.Code, etag)
		}
		cached := f.request(t, "files/raw", confined(map[string]string{"path": "README.md"}), map[string]string{"If-None-Match": etag})
		if cached.Code != http.StatusNotModified {
			t.Fatalf("files/raw with a matching ETag: %d, want 304", cached.Code)
		}
		if cached.Header().Get(pathConfinementHeader) != pathConfinementWorkDir {
			t.Fatal("a confined 304 did not confirm confinement")
		}
	})
}

// The untracked fallback in git/diff cats the file, which follows symlinks.
func TestConfinedGitDiffDoesNotCatAnUntrackedSymlinkOut(t *testing.T) {
	forEachConfinementRuntime(t, func(t *testing.T, f confinementFixture) {
		for _, path := range []string{"rel-link", "vendor/lib/.git/config"} {
			rec := f.get(t, "git/diff", confined(map[string]string{"path": path}))
			body := bodyOf(t, rec)
			if strings.Contains(body, "outside secret") || strings.Contains(body, "inside .git") {
				t.Fatalf("git/diff %q read out of the working tree: %s", path, body)
			}
			// Refused like every other endpoint, not answered as an empty diff.
			if rec.Code != http.StatusNotFound {
				t.Fatalf("git/diff %q: status %d, want 404: %s", path, rec.Code, body)
			}
			if rec.Header().Get(pathConfinementHeader) != pathConfinementWorkDir {
				t.Fatal("git/diff did not confirm confinement")
			}
		}
		// Control: an untracked file inside the tree still shows as all additions.
		if err := os.WriteFile(filepath.Join(f.repo, "new.txt"), []byte("brand new\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		inside := f.get(t, "git/diff", confined(map[string]string{"path": "new.txt"}))
		if inside.Code != http.StatusOK || !strings.Contains(bodyOf(t, inside), "+brand new") {
			t.Fatalf("git/diff of an untracked file: %d %s", inside.Code, bodyOf(t, inside))
		}
		for _, path := range []string{"/etc/hostname", "../outside/secret.txt"} {
			rec := f.get(t, "git/diff", confined(map[string]string{"path": path}))
			if rec.Code != http.StatusNotFound {
				t.Fatalf("git/diff %q: status %d, want 404: %s", path, rec.Code, bodyOf(t, rec))
			}
		}
	})
}

// The owner's requests carry no confine parameter: unchanged, and not marked as confined.
func TestUnconfinedReadsAreUnchangedForTheOwner(t *testing.T) {
	forEachConfinementRuntime(t, func(t *testing.T, f confinementFixture) {
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
		// The owner's traversal answer keeps its wording.
		traversal := f.get(t, "files/raw", map[string]string{"path": "../outside/secret.txt"})
		if traversal.Code != http.StatusBadRequest || !strings.Contains(bodyOf(t, traversal), "path traversal is not allowed") {
			t.Fatalf("owner traversal: %d %s", traversal.Code, bodyOf(t, traversal))
		}
	})
}

// On a VM the resolution, the stat and the read all run through docker exec, in the workspace's
// devcontainer, as its user and from its working directory.
func TestConfinedReadsRunThroughDockerExecOnAVM(t *testing.T) {
	f := newConfinementFixture(t, confinementDevcontainer)
	rec := f.get(t, "files/raw", confined(map[string]string{"path": "README.md"}))
	if rec.Code != http.StatusOK || !strings.Contains(bodyOf(t, rec), "hello from the repo") {
		t.Fatalf("files/raw: %d %s", rec.Code, bodyOf(t, rec))
	}
	resolved, err := filepath.EvalSymlinks(f.repo)
	if err != nil {
		t.Fatal(err)
	}
	prefix := "exec -i -u node -w " + f.repo + " " + confinementContainerID + " "
	calls := f.dockerCalls()
	for _, want := range []string{
		prefix + "realpath . ./README.md",
		prefix + "stat -c %F\t%s\t%Y -- " + resolved + "/README.md",
		prefix + "cat -- " + resolved + "/README.md",
	} {
		if !slices.Contains(calls, want) {
			t.Fatalf("missing docker call %q in %q", want, calls)
		}
	}
}

func TestUnknownConfinementIsRefused(t *testing.T) {
	f := newConfinementFixture(t, confinementStandalone)
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
		{"/w/repo", "/w/repo/vendor/lib/.git", false},
		{"/w/repo", "/w/repo/vendor/lib/.git/config", false},
		{"/w/repo", "/w/repo/.gitignore", true},
		{"/w/repo", "/w/repo/.github/workflows/ci.yml", true},
		{"/w/repo", "/w/repo/vendor/.git-backup/x", true},
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
	// Ways out of the working tree read as not found.
	for _, path := range []string{"/etc/passwd", "~/.ssh/id_rsa", "~", "../x", "a/../../x"} {
		if _, err := sanitizeConfinedPath(path); !errors.Is(err, errPathOutsideWorkTree) {
			t.Errorf("sanitizeConfinedPath(%q) err=%v, want errPathOutsideWorkTree", path, err)
		}
	}
	// Malformed paths are bad requests.
	for _, path := range []string{"a\nb", "a\rb", ""} {
		_, err := sanitizeConfinedPath(path)
		if err == nil || errors.Is(err, errPathOutsideWorkTree) {
			t.Errorf("sanitizeConfinedPath(%q) err=%v, want a malformed-path error", path, err)
		}
	}
}
