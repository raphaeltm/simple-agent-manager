package acp

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type antigravityInstallCase struct {
	name, arch, libc  string
	corrupt, previous bool
	wantAsset         string
}

// Execute the real installer under /bin/sh. Only platform detection and the
// download boundary are stubbed; hashing, extraction, replacement, launcher
// generation and cleanup are real.
func TestAntigravityReleaseInstaller(t *testing.T) {
	for _, tt := range []antigravityInstallCase{
		{name: "x86_64 fresh install", arch: "x86_64", wantAsset: "linux-x86_64"},
		{name: "arm64 fresh install", arch: "aarch64", wantAsset: "linux-arm64"},
		{name: "reinstall replaces release and sweeps leftovers", arch: "x86_64", previous: true, wantAsset: "linux-x86_64"},
		{name: "checksum mismatch preserves installed release", arch: "x86_64", previous: true, corrupt: true, wantAsset: "linux-x86_64"},
		{name: "musl rejects before download", arch: "x86_64", libc: "musl"},
		{name: "unsupported arch rejects before download", arch: "riscv64"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newAntigravityInstallFixture(t, tt)
			output, err := f.command().CombinedOutput()
			wantOK := tt.wantAsset != "" && !tt.corrupt
			if (err == nil) != wantOK {
				t.Fatalf("success=%v want %v: %s", err == nil, wantOK, output)
			}
			f.assertDownload(t, tt.wantAsset)
			if wantOK {
				f.assertInstalled(t)
			} else if tt.previous {
				f.assertPreviousIntact(t)
			}
		})
	}
}

type antigravityInstallFixture struct {
	root, tools, home, lib, archive string
	release                         []byte
}

func newAntigravityInstallFixture(t *testing.T, tt antigravityInstallCase) antigravityInstallFixture {
	t.Helper()
	root := t.TempDir()
	f := antigravityInstallFixture{
		root: root, tools: filepath.Join(root, "tools"), home: filepath.Join(root, "agents"),
		archive: filepath.Join(root, "release.zip"),
	}
	f.lib = filepath.Join(f.home, "lib", "antigravity-acp")
	for _, dir := range []string{f.tools, filepath.Join(f.home, "bin")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	f.release = antigravityReleaseZip(t, map[string]string{
		// The fake server reports the harness path and arguments it was given.
		"agy_acp_server.par":    "#!/bin/sh\nprintf '%s|%s\\n' \"$ANTIGRAVITY_HARNESS_PATH\" \"$*\"\n",
		"localharness_external": "#!/bin/sh\nexit 0\n",
	})
	archive := f.release
	if tt.corrupt {
		archive = []byte("corrupt archive")
	}
	writeOpenCodeFixtureFile(t, f.archive, archive, 0o600)
	if tt.previous {
		f.seedPreviousInstall(t)
	}
	stubs := map[string]string{
		"uname": "case \"$1\" in -s) echo Linux;; -m) echo " + tt.arch + ";; esac\n",
		"ldd":   "echo '" + tt.libc + " libc'\n",
		"curl":  "printf '%s\\n' \"$@\" > \"$PROBE_LOG\"\nwhile [ \"$1\" != -o ]; do shift; done\ncp \"$PROBE_ARCHIVE\" \"$2\"\n",
	}
	for name, script := range stubs {
		writeOpenCodeFixtureFile(t, filepath.Join(f.tools, name), []byte("#!/bin/sh\n"+script), 0o755)
	}
	return f
}

// seedPreviousInstall leaves a working release of the same version, an older
// release, and a stage from a killed install.
func (f antigravityInstallFixture) seedPreviousInstall(t *testing.T) {
	t.Helper()
	current := filepath.Join(f.lib, antigravityVersion)
	for _, dir := range []string{current, filepath.Join(f.lib, "1.4.4"), filepath.Join(f.lib, ".install.killed")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeOpenCodeFixtureFile(t, filepath.Join(current, "agy_acp_server.par"), []byte("previous"), 0o755)
	writeOpenCodeFixtureFile(t, filepath.Join(f.home, "bin", "agy-acp"), []byte("#!/bin/sh\n# sam-antigravity-version="+antigravityVersion+"\n"), 0o755)
}

func antigravityReleaseZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var data bytes.Buffer
	zw := zip.NewWriter(&data)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func (f antigravityInstallFixture) command() *exec.Cmd {
	// Swap the pinned digests for the fixture's so the real check runs.
	script := antigravityInstallScript
	for _, line := range strings.Split(script, "\n") {
		if _, digest, ok := strings.Cut(strings.TrimSpace(line), "digest="); ok {
			script = strings.ReplaceAll(script, digest, fmt.Sprintf("%x", sha256.Sum256(f.release)))
		}
	}
	cmd := exec.Command(localShellPath, "-c", script)
	cmd.Env = append(os.Environ(),
		"PATH="+filepath.Join(f.home, "bin")+":"+f.tools+":"+os.Getenv("PATH"),
		"SAM_AGENT_HOME="+f.home,
		"PROBE_ARCHIVE="+f.archive,
		"PROBE_LOG="+filepath.Join(f.root, "download.log"))
	return cmd
}

func (f antigravityInstallFixture) assertDownload(t *testing.T, wantAsset string) {
	t.Helper()
	log, err := os.ReadFile(filepath.Join(f.root, "download.log"))
	if wantAsset == "" {
		if err == nil {
			t.Fatalf("rejected platform still downloaded: %s", log)
		}
		return
	}
	if err != nil {
		t.Fatalf("no download recorded: %v", err)
	}
	want := "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-" + antigravityVersion + "-" + wantAsset + ".zip"
	if !strings.Contains(string(log), want+"\n") || !strings.Contains(string(log), "=https\n") {
		t.Fatalf("download args = %q, want HTTPS-only %s", log, want)
	}
}

func (f antigravityInstallFixture) assertInstalled(t *testing.T) {
	t.Helper()
	// The VM agent's own validation command must accept the result.
	check := exec.Command(localShellPath, "-c", antigravityVersionCheckCommand())
	check.Env = append(os.Environ(), "PATH="+filepath.Join(f.home, "bin")+":"+os.Getenv("PATH"))
	if output, err := check.CombinedOutput(); err != nil {
		t.Fatalf("validation command rejected the install: %v: %s", err, output)
	}
	launch := exec.Command(filepath.Join(f.home, "bin", "agy-acp"), "--uid=")
	launch.Env = append(os.Environ(), "ANTIGRAVITY_HARNESS_PATH=")
	output, err := launch.Output()
	if err != nil {
		t.Fatalf("launcher failed: %v", err)
	}
	wantHarness := filepath.Join(f.lib, antigravityVersion, "localharness_external")
	if got := strings.TrimSpace(string(output)); got != wantHarness+"|--uid=" {
		t.Fatalf("launcher ran %q, want harness %s and args --uid=", got, wantHarness)
	}
	entries, err := os.ReadDir(f.lib)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != antigravityVersion {
		names := []string{}
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("release directory holds %v, want only %s", names, antigravityVersion)
	}
}

func (f antigravityInstallFixture) assertPreviousIntact(t *testing.T) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.lib, antigravityVersion, "agy_acp_server.par"))
	if err != nil || string(data) != "previous" {
		t.Fatalf("failed install changed the working release: %q, %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(f.home, "bin", "agy-acp")); err != nil {
		t.Fatalf("failed install removed the launcher: %v", err)
	}
}
