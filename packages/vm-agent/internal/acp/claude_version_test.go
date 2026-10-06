package acp

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeInstalledCheckRejectsStaleRuntime(t *testing.T) {
	t.Parallel()
	adapter := strings.TrimPrefix(claudeACPInstallPackage, "@agentclientprotocol/claude-agent-acp@")
	for _, credential := range []string{"api-key", "oauth-token"} {
		for _, tt := range []struct {
			name, adapter, cli string
			wantOK             bool
		}{
			{"supported", adapter, "2.1.281 (Claude Code)", true},
			{"minimum", adapter, "2.1.280 (Claude Code)", true},
			{"stale embedded SDK with new CLI", "0.73.0", "2.1.281 (Claude Code)", false},
			{"stale companion", adapter, "2.1.260 (Claude Code)", false},
			{"reported failure", "0.73.0", "2.1.257 (Claude Code)", false},
			{"missing adapter", "", "2.1.281 (Claude Code)", false},
			{"malformed CLI", adapter, "unknown", false},
			{"missing CLI", adapter, "", false},
			{"newer CLI", adapter, "2.2.0 (Claude Code)", true},
		} {
			t.Run(credential+"/"+tt.name, func(t *testing.T) {
				t.Parallel()
				dir := t.TempDir()
				for name, output := range map[string]string{"claude-agent-acp": tt.adapter, "claude": tt.cli} {
					if output == "" {
						continue
					}
					if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\nprintf '%s\\n' '"+output+"'\n"), 0700); err != nil {
						t.Fatal(err)
					}
				}
				// Only the POSIX utilities used by the check are available; Node is absent.
				for _, name := range []string{"sed", "head"} {
					executable, err := exec.LookPath(name)
					if err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(executable, filepath.Join(dir, name)); err != nil {
						t.Fatal(err)
					}
				}
				cmd := exec.Command(localShellPath, "-c", agentInstalledCheckScript(getAgentCommandInfo("claude-code", credential)))
				cmd.Env = []string{"PATH=" + dir}
				output, err := cmd.CombinedOutput()
				if (err == nil) != tt.wantOK {
					t.Fatalf("check success=%v, want %v: %s (%v)", err == nil, tt.wantOK, output, err)
				}
			})
		}
	}
}

func TestAgentInstallBootstrapsSupportedNode(t *testing.T) {
	t.Parallel()
	for _, version := range []string{"20", "22"} {
		t.Run(version, func(t *testing.T) {
			t.Parallel()
			dir := t.TempDir()
			log := filepath.Join(dir, "calls")
			scripts := map[string]string{
				"node":    "echo " + version,
				"which":   "exit 0",
				"rm":      "exit 0",
				"apt-get": "exit 0",
				"npm":     "echo npm >> '" + log + "'",
				"n":       "echo node-upgrade >> '" + log + "'",
			}
			for name, body := range scripts {
				if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			info := agentCommandInfo{isNpmBased: true, installCmd: "echo agent-install >> '" + log + "'"}
			cmd := exec.Command(localShellPath, "-c", agentInstallScript(info))
			cmd.Env = []string{"PATH=" + dir}
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("bootstrap: %v %s", err, out)
			}
			calls, err := os.ReadFile(log)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(calls), "node-upgrade") != (version == "20") {
				t.Fatalf("Node %s bootstrap calls: %s", version, calls)
			}
			if !strings.HasSuffix(string(calls), "agent-install\n") {
				t.Fatalf("missing install after bootstrap: %s", calls)
			}
		})
	}
}

func TestOtherHarnessInstalledChecksRejectStaleVersions(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct{ agent, bin, current, stale string }{
		{"google-gemini", "gemini", "0.61.0", "0.50.0"},
		{"opencode", "opencode", "1.18.32", "1.18.27"},
		{"mistral-vibe", "vibe-acp", "vibe-acp 2.25.8", "vibe-acp 2.19.1"},
		{"amp", "amp", "0.0.1790261352-g2ab14a (released today)", "0.0.1783785389-g0da70d (released yesterday)"},
	} {
		t.Run(tt.agent, func(t *testing.T) {
			t.Parallel()
			dir := t.TempDir()
			info := getAgentCommandInfo(tt.agent, "api-key")
			for _, output := range []string{tt.current, tt.stale, "", tt.current + "0"} {
				if err := os.WriteFile(filepath.Join(dir, info.command), []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, tt.bin), []byte("#!/bin/sh\nprintf '%s\\n' '"+output+"'\n"), 0700); err != nil {
					t.Fatal(err)
				}
				cmd := exec.Command(localShellPath, "-c", agentInstalledCheckScript(info))
				cmd.Env = []string{"PATH=" + dir}
				err := cmd.Run()
				wantOK := output == tt.current
				// Amp's human-readable release suffix is not part of its version token.
				if tt.agent == "amp" && output == tt.current+"0" {
					wantOK = true
				}
				if (err == nil) != wantOK {
					t.Fatalf("output %q success=%v want %v", output, err == nil, wantOK)
				}
			}
		})
	}
}
