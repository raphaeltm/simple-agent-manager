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

// Execute the real installer under /bin/sh. Only platform detection and the
// download boundary are stubbed; extraction, hashing and replacement are real.
func TestOpenCodeReleaseInstaller(t *testing.T) {
	for _, tt := range []struct {
		name, arch, libc, version       string
		corrupt, unsupported, npmPrefix bool
	}{
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
			root := t.TempDir()
			bin := filepath.Join(root, "tools")
			home := filepath.Join(root, "agents")
			dest := filepath.Join(home, "bin")
			if tt.npmPrefix {
				dest = filepath.Join(root, "nvm", "bin")
			}
			for _, d := range []string{bin, dest} {
				if err := os.MkdirAll(d, 0755); err != nil {
					t.Fatal(err)
				}
			}
			write := func(p, s string) {
				t.Helper()
				if err := os.WriteFile(p, []byte(s), 0755); err != nil {
					t.Fatal(err)
				}
			}
			old := filepath.Join(root, "npm-opencode")
			write(old, "old binary")
			if err := os.Symlink(old, filepath.Join(dest, "opencode")); err != nil {
				t.Fatal(err)
			}
			var data bytes.Buffer
			gz := gzip.NewWriter(&data)
			tw := tar.NewWriter(gz)
			contents := []byte("#!/bin/sh\nprintf '%s\\n' '" + tt.version + "'\n")
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
			archive := filepath.Join(root, "release.tar.gz")
			if err := os.WriteFile(archive, data.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
			script := opencodeInstallScript
			for _, line := range strings.Split(script, "\n") {
				if _, digest, ok := strings.Cut(line, "digest="); ok {
					digest = strings.TrimSuffix(digest, " ;;")
					script = strings.ReplaceAll(script, digest, fmt.Sprintf("%x", sha256.Sum256(data.Bytes())))
				}
			}
			if tt.corrupt {
				write(archive, "corrupt archive")
			}
			write(filepath.Join(bin, "uname"), "#!/bin/sh\ncase \"$1\" in -s) echo Linux;; -m) echo "+tt.arch+";; esac\n")
			write(filepath.Join(bin, "apk"), "#!/bin/sh\nif [ \"$1\" = info ]; then exit 1; fi\nprintf \"%s\\n\" \"$*\" > \"$PROBE_APK_LOG\"\n")
			write(filepath.Join(bin, "ldd"), "#!/bin/sh\necho '"+tt.libc+" libc'\n")
			// Capture the requested release URL and supply the local archive at the HTTP boundary.
			write(filepath.Join(bin, "curl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$PROBE_LOG\"\nfor arg do case \"$arg\" in https://*) url=$arg;; esac; done\nwhile [ \"$1\" != -o ]; do shift; done\ncp \"$PROBE_ARCHIVE\" \"$2\"\n")
			cmd := exec.Command(localShellPath, "-c", script)
			managedHome := home
			if tt.npmPrefix {
				managedHome = ""
			}
			cmd.Env = append(os.Environ(), "PATH="+dest+":"+bin+":"+os.Getenv("PATH"), "SAM_AGENT_HOME="+managedHome, "PROBE_ARCHIVE="+archive, "PROBE_LOG="+filepath.Join(root, "download.log"), "PROBE_APK_LOG="+filepath.Join(root, "apk.log"))
			output, err := cmd.CombinedOutput()
			wantOK := !tt.corrupt && !tt.unsupported && tt.version == "opencode v2.2.5"
			if (err == nil) != wantOK {
				t.Fatalf("success=%v want %v: %s", err == nil, wantOK, output)
			}
			installed, err := os.ReadFile(filepath.Join(dest, "opencode"))
			if err != nil {
				t.Fatal(err)
			}
			if wantOK {
				if !bytes.Equal(installed, contents) {
					t.Fatal("release not installed")
				}
			} else if string(installed) != "old binary" {
				t.Fatal("failed install modified existing binary")
			}
			if b, err := os.ReadFile(old); err != nil || string(b) != "old binary" {
				t.Fatal("npm symlink target modified")
			}
			leftovers, _ := filepath.Glob(filepath.Join(dest, ".opencode-install.*"))
			if len(leftovers) > 0 {
				t.Fatal("staging files leaked", leftovers)
			}
			log, err := os.ReadFile(filepath.Join(root, "download.log"))
			if tt.unsupported {
				if !os.IsNotExist(err) {
					t.Fatal("unsupported arch downloaded")
				}
				return
			}
			if tt.libc == "musl" {
				packages, err := os.ReadFile(filepath.Join(root, "apk.log"))
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
		})
	}
}
