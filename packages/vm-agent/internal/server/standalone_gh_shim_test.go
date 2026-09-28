package server

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// writeFakeGh installs an executable gh into a fresh directory (whose name
// needs shell quoting) that reports its identity and the GH_TOKEN it received.
func writeFakeGh(t *testing.T, identity string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "sys bin's "+identity)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("create fake gh dir: %v", err)
	}
	script := "#!/bin/sh\nprintf '" + identity + " GH_TOKEN=%s args=%s\\n' \"${GH_TOKEN:-}\" \"$*\"\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatalf("write fake gh: %v", err)
	}
	return dir
}

func pathList(dirs ...string) string {
	return strings.Join(dirs, string(os.PathListSeparator))
}

// runGh runs `gh` the way an agent shell does: resolved by PATH lookup, with
// pathDirs ahead of the tools the shim itself uses. The deadline kills the whole
// process group, so a shim that execs itself fails the test instead of hanging
// the suite and leaking a spinning process.
func runGh(t *testing.T, env []string, pathDirs string, args ...string) (stdout, stderr string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sh", append([]string{"-c", `gh "$@"`, "sh"}, args...)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	cmd.Env = append(env, "PATH="+pathList(pathDirs, os.Getenv("PATH")))
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		t.Fatalf("run gh: %v (stdout=%q stderr=%q)", err, outBuf.String(), errBuf.String())
	}
	return strings.TrimSpace(outBuf.String()), strings.TrimSpace(errBuf.String())
}

func installShim(t *testing.T, shimDir, credentialHelperPath, pathEnv string) string {
	t.Helper()
	shimPath, err := installStandaloneGhShim(shimDir, credentialHelperPath, pathEnv)
	if err != nil {
		t.Fatalf("install gh shim: %v", err)
	}
	return shimPath
}

// TestStandaloneGhShimExchangesFreshTokenInsteadOfSessionGHToken drives `gh`
// from a shell through PATH resolution, the shim, the rendered credential
// helper, and the real /git-credential handler. The session's GH_TOKEN is stale
// by construction, so gh must run with the freshly minted token.
func TestStandaloneGhShimExchangesFreshTokenInsteadOfSessionGHToken(t *testing.T) {
	t.Parallel()
	exchange := newStandaloneCredentialExchange(t, "ws-instant", http.StatusOK, "fresh-exchange-token")
	systemBin := writeFakeGh(t, "system-gh")
	shimDir := t.TempDir()
	installShim(t, shimDir, exchange.helperPath, pathList(shimDir, systemBin))

	stdout, stderr := runGh(t, exchange.agentEnv("stale-session-token"), pathList(shimDir, systemBin), "api", "user")

	if want := "system-gh GH_TOKEN=fresh-exchange-token args=api user"; stdout != want {
		t.Fatalf("gh output = %q, want %q", stdout, want)
	}
	if stderr != "" {
		t.Fatalf("unexpected gh stderr: %q", stderr)
	}
	if got := exchange.mintCalls.Load(); got != 1 {
		t.Fatalf("control plane token mints = %d, want 1", got)
	}
}

// TestStandaloneGhShimNeverFallsBackToTheSessionGHToken covers a refused
// exchange, such as a revoked installation or a GitHub CLI policy that forbids
// minting: gh must still run (liveness) but without the inherited token.
func TestStandaloneGhShimNeverFallsBackToTheSessionGHToken(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name           string
		sessionGHToken string
		wantStderr     string
	}{
		{
			name:           "session token is dropped with a diagnostic",
			sessionGHToken: "stale-session-token",
			wantStderr:     "gh: SAM could not refresh GitHub credentials; not using the GH_TOKEN inherited at session start",
		},
		{
			name:           "no session token means nothing to report",
			sessionGHToken: "",
			wantStderr:     "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			exchange := newStandaloneCredentialExchange(t, "ws-instant", http.StatusForbidden, "")
			systemBin := writeFakeGh(t, "system-gh")
			shimDir := t.TempDir()
			installShim(t, shimDir, exchange.helperPath, pathList(shimDir, systemBin))

			stdout, stderr := runGh(t, exchange.agentEnv(tc.sessionGHToken), pathList(shimDir, systemBin), "pr", "list")

			if want := "system-gh GH_TOKEN= args=pr list"; stdout != want {
				t.Fatalf("gh output = %q, want %q", stdout, want)
			}
			if stderr != tc.wantStderr {
				t.Fatalf("gh stderr = %q, want %q", stderr, tc.wantStderr)
			}
			if got := exchange.mintCalls.Load(); got != 1 {
				t.Fatalf("control plane token mints = %d, want 1 attempted exchange", got)
			}
		})
	}
}

// TestInstallStandaloneGhShimWrapsTheGhItShadows proves which gh the shim execs
// by running it: each candidate gh reports its own identity.
func TestInstallStandaloneGhShimWrapsTheGhItShadows(t *testing.T) {
	t.Parallel()
	noExchange := hermeticEnv() // no SAM_WORKSPACE_ID: the helper yields nothing

	t.Run("first gh on PATH after the shim dir", func(t *testing.T) {
		t.Parallel()
		shimDir, systemBin, laterBin := t.TempDir(), writeFakeGh(t, "system-gh"), writeFakeGh(t, "later-gh")
		installShim(t, shimDir, "/nonexistent/git-credential-sam", pathList(shimDir, t.TempDir(), systemBin, laterBin))

		if stdout, _ := runGh(t, noExchange, shimDir, "--version"); stdout != "system-gh GH_TOKEN= args=--version" {
			t.Fatalf("shim reached %q, want system-gh", stdout)
		}
	})

	t.Run("reinstall never wraps the shim itself", func(t *testing.T) {
		t.Parallel()
		shimDir, systemBin := t.TempDir(), writeFakeGh(t, "system-gh")
		installShim(t, shimDir, "/nonexistent/git-credential-sam", pathList(shimDir, systemBin))
		installShim(t, shimDir, "/nonexistent/git-credential-sam", pathList(shimDir, systemBin))

		if stdout, _ := runGh(t, noExchange, shimDir, "--version"); stdout != "system-gh GH_TOKEN= args=--version" {
			t.Fatalf("shim reached %q, want system-gh", stdout)
		}
	})

	t.Run("a symlink back into the shim dir is skipped", func(t *testing.T) {
		t.Parallel()
		shimDir, systemBin, linkDir := t.TempDir(), writeFakeGh(t, "system-gh"), t.TempDir()
		installShim(t, shimDir, "/nonexistent/git-credential-sam", pathList(shimDir, systemBin))
		if err := os.Symlink(filepath.Join(shimDir, "gh"), filepath.Join(linkDir, "gh")); err != nil {
			t.Fatalf("symlink: %v", err)
		}
		installShim(t, shimDir, "/nonexistent/git-credential-sam", pathList(linkDir, shimDir, systemBin))

		if stdout, _ := runGh(t, noExchange, shimDir, "--version"); stdout != "system-gh GH_TOKEN= args=--version" {
			t.Fatalf("shim reached %q, want system-gh", stdout)
		}
	})

	t.Run("relative PATH entries are never adopted", func(t *testing.T) {
		t.Parallel()
		cwd, err := os.Getwd()
		if err != nil {
			t.Fatalf("getwd: %v", err)
		}
		relativeBin, err := filepath.Rel(cwd, writeFakeGh(t, "relative-gh"))
		if err != nil {
			t.Fatalf("relative path: %v", err)
		}
		shimDir, systemBin := t.TempDir(), writeFakeGh(t, "system-gh")
		installShim(t, shimDir, "/nonexistent/git-credential-sam", pathList(shimDir, relativeBin, systemBin))

		if stdout, _ := runGh(t, noExchange, shimDir, "--version"); stdout != "system-gh GH_TOKEN= args=--version" {
			t.Fatalf("shim reached %q, want system-gh", stdout)
		}
	})
}

func TestInstallStandaloneGhShimSkipsWhenGhIsNotInstalled(t *testing.T) {
	t.Parallel()
	shimDir := t.TempDir()

	shimPath := installShim(t, shimDir, "/nonexistent/git-credential-sam", pathList(shimDir, t.TempDir()))

	if shimPath != "" {
		t.Fatalf("shim path = %q, want none without gh", shimPath)
	}
	if _, err := os.Stat(filepath.Join(shimDir, "gh")); !os.IsNotExist(err) {
		t.Fatalf("shim written without gh installed: %v", err)
	}
}

func TestInstallStandaloneGhShimRestoresOwnerOnlyExecutableMode(t *testing.T) {
	t.Parallel()
	shimDir, systemBin := t.TempDir(), writeFakeGh(t, "system-gh")
	if err := os.WriteFile(filepath.Join(shimDir, "gh"), []byte("#!/bin/sh\necho stale shim\n"), 0o755); err != nil {
		t.Fatalf("seed stale shim: %v", err)
	}

	shimPath := installShim(t, shimDir, "/nonexistent/git-credential-sam", pathList(shimDir, systemBin))

	info, err := os.Stat(shimPath)
	if err != nil {
		t.Fatalf("stat shim: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Fatalf("shim mode = %o, want 700", got)
	}
	if stdout, _ := runGh(t, hermeticEnv(), shimDir, "--version"); stdout != "system-gh GH_TOKEN= args=--version" {
		t.Fatalf("stale shim was not replaced: %q", stdout)
	}
}
