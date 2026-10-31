package acp

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type openCodeInstallCase struct {
	name, arch, libc, version       string
	corrupt, unsupported, npmPrefix bool
}

type openCodeInstallFixture struct {
	root, bin, home, dest, old, archive string
	contents, release                   []byte
}

// Execute the real installer under /bin/sh. Only platform detection and the
// download boundary are stubbed; extraction, hashing and replacement are real.
func TestOpenCodeReleaseInstaller(t *testing.T) {
	for _, tt := range []openCodeInstallCase{
		{name: "x64 glibc replaces npm symlink", arch: "x86_64", version: "opencode v2.2.5"},
		{name: "existing npm prefix ahead of system bin", arch: "x86_64", version: "opencode v2.2.5", npmPrefix: true},
		{name: "x64 musl", arch: "x86_64", libc: "musl", version: "opencode v2.2.5"},
		{name: "arm64 glibc", arch: "aarch64", version: "opencode v2.2.5"},
		{name: "arm64 musl", arch: "arm64", libc: "musl", version: "opencode v2.2.5"},
		{name: "checksum mismatch preserves installed binary", arch: "x86_64", version: "opencode v2.2.5", corrupt: true},
		{name: "wrong version preserves installed binary", arch: "x86_64", version: "1.18.32"},
		{name: "unsupported arch rejects before download", arch: "riscv64", unsupported: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newOpenCodeInstallFixture(t, tt)
			cmd := fixture.command()
			output, err := cmd.CombinedOutput()
			wantOK := !tt.corrupt && !tt.unsupported && tt.version == "opencode v2.2.5"
			if (err == nil) != wantOK {
				t.Fatalf("success=%v want %v: %s", err == nil, wantOK, output)
			}
			fixture.assertInstalledState(t, wantOK)
			fixture.assertDownload(t, tt)
		})
	}
}

func writeOpenCodeFixtureFile(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
}

func openCodeReleaseArchive(t *testing.T, contents []byte) []byte {
	t.Helper()
	var data bytes.Buffer
	gz := gzip.NewWriter(&data)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "opencode", Mode: 0755, Size: int64(len(contents))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(contents); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func newOpenCodeInstallFixture(t *testing.T, tt openCodeInstallCase) openCodeInstallFixture {
	t.Helper()
	root := t.TempDir()
	f := openCodeInstallFixture{
		root: root, bin: filepath.Join(root, "tools"), home: filepath.Join(root, "agents"),
		old: filepath.Join(root, "npm-opencode"), archive: filepath.Join(root, "release.tar.gz"),
		contents: []byte("#!/bin/sh\nprintf '%s\\n' '" + tt.version + "'\n"),
	}
	f.dest = filepath.Join(f.home, "bin")
	if tt.npmPrefix {
		f.dest = filepath.Join(root, "nvm", "bin")
		f.home = ""
	}
	for _, d := range []string{f.bin, f.dest} {
		if err := os.MkdirAll(d, 0755); err != nil {
			t.Fatal(err)
		}
	}
	writeOpenCodeFixtureFile(t, f.old, []byte("old binary"), 0755)
	if err := os.Symlink(f.old, filepath.Join(f.dest, "opencode")); err != nil {
		t.Fatal(err)
	}
	f.release = openCodeReleaseArchive(t, f.contents)
	archive := f.release
	if tt.corrupt {
		archive = []byte("corrupt archive")
	}
	writeOpenCodeFixtureFile(t, f.archive, archive, 0600)
	f.writeBoundaryStubs(t, tt)
	return f
}

func (f openCodeInstallFixture) writeBoundaryStubs(t *testing.T, tt openCodeInstallCase) {
	t.Helper()
	stubs := map[string]string{
		"uname": "case \"$1\" in -s) echo Linux;; -m) echo " + tt.arch + ";; esac\n",
		"apk":   "if [ \"$1\" = info ]; then exit 1; fi\nprintf \"%s\\n\" \"$*\" > \"$PROBE_APK_LOG\"\n",
		"ldd":   "echo '" + tt.libc + " libc'\n",
		// Capture individual arguments, preserving option/value boundaries.
		"curl": "printf '%s\\n' \"$@\" > \"$PROBE_LOG\"\nwhile [ \"$1\" != -o ]; do shift; done\ncp \"$PROBE_ARCHIVE\" \"$2\"\n",
	}
	for name, script := range stubs {
		writeOpenCodeFixtureFile(t, filepath.Join(f.bin, name), []byte("#!/bin/sh\n"+script), 0755)
	}
}

func (f openCodeInstallFixture) command() *exec.Cmd {
	script := opencodeInstallScript
	for _, line := range strings.Split(script, "\n") {
		if _, digest, ok := strings.Cut(line, "digest="); ok {
			digest = strings.TrimSuffix(digest, " ;;")
			script = strings.ReplaceAll(script, digest, fmt.Sprintf("%x", sha256.Sum256(f.release)))
		}
	}
	cmd := exec.Command(localShellPath, "-c", script)
	cmd.Env = append(os.Environ(), "PATH="+f.dest+":"+f.bin+":"+os.Getenv("PATH"), "SAM_AGENT_HOME="+f.home,
		"PROBE_ARCHIVE="+f.archive, "PROBE_LOG="+filepath.Join(f.root, "download.log"), "PROBE_APK_LOG="+filepath.Join(f.root, "apk.log"))
	return cmd
}

func (f openCodeInstallFixture) assertInstalledState(t *testing.T, wantOK bool) {
	t.Helper()
	installed, err := os.ReadFile(filepath.Join(f.dest, "opencode"))
	if err != nil {
		t.Fatal(err)
	}
	want := []byte("old binary")
	if wantOK {
		want = f.contents
	}
	if !bytes.Equal(installed, want) {
		t.Fatalf("installed contents differ (successful install=%v)", wantOK)
	}
	if b, err := os.ReadFile(f.old); err != nil || string(b) != "old binary" {
		t.Fatal("npm symlink target modified")
	}
	leftovers, err := filepath.Glob(filepath.Join(f.dest, ".opencode-install.*"))
	if err != nil || len(leftovers) > 0 {
		t.Fatal("staging files leaked", leftovers, err)
	}
}

func (f openCodeInstallFixture) assertDownload(t *testing.T, tt openCodeInstallCase) {
	t.Helper()
	log, err := os.ReadFile(filepath.Join(f.root, "download.log"))
	if tt.unsupported {
		if !os.IsNotExist(err) {
			t.Fatal("unsupported arch downloaded")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	for _, option := range []string{"--proto", "--proto-redir"} {
		if !strings.Contains(string(log), option+"\n=https\n") {
			t.Fatalf("download did not restrict %s to HTTPS: %s", option, log)
		}
	}
	if tt.libc == "musl" {
		packages, err := os.ReadFile(filepath.Join(f.root, "apk.log"))
		if err != nil || !strings.Contains(string(packages), "add --no-cache libstdc++") {
			t.Fatal("missing musl runtime prerequisite", err)
		}
	}
	target := "linux-arm64"
	if tt.arch == "x86_64" {
		target = "linux-x64-baseline"
	}
	if tt.libc == "musl" {
		target += "-musl"
	}
	if !strings.Contains(string(log), "/v2.2.5/opencode-"+target+".tar.gz") {
		t.Fatalf("wrong download: %s", log)
	}
}
