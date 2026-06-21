package deploy

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeExecutable(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0755); err != nil {
		t.Fatalf("write executable %s: %v", name, err)
	}
	return path
}

func prependFakeBin(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(t.TempDir(), "calls.log")
	t.Setenv("CALL_LOG", logPath)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return dir, logPath
}

func readCallLog(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("read call log: %v", err)
	}
	return string(content)
}

func TestEnsureDockerFastPathReturnsServiceStartErrors(t *testing.T) {
	binDir, logPath := prependFakeBin(t)
	writeExecutable(t, binDir, "docker", "#!/bin/sh\nexit 0\n")
	writeExecutable(t, binDir, "systemctl", `#!/bin/sh
echo "systemctl $*" >> "$CALL_LOG"
if [ "$1" = "start" ] && [ "$2" = "docker" ]; then
  echo "docker did not start" >&2
  exit 17
fi
exit 0
`)

	err := ensureDocker(context.Background(), nil)
	if err == nil {
		t.Fatal("ensureDocker returned nil; want start docker failure")
	}
	if !strings.Contains(err.Error(), "start docker") {
		t.Fatalf("ensureDocker error = %q, want start docker context", err)
	}

	calls := readCallLog(t, logPath)
	if !strings.Contains(calls, "systemctl enable docker") {
		t.Fatalf("systemctl enable docker was not called; calls:\n%s", calls)
	}
	if !strings.Contains(calls, "systemctl start docker") {
		t.Fatalf("systemctl start docker was not called; calls:\n%s", calls)
	}
}

func TestEnsureCaddyFastPathReturnsServiceRestartErrors(t *testing.T) {
	binDir, _ := prependFakeBin(t)
	writeExecutable(t, binDir, "caddy", "#!/bin/sh\nexit 0\n")
	writeExecutable(t, binDir, "id", "#!/bin/sh\nexit 0\n")
	writeExecutable(t, binDir, "systemctl", `#!/bin/sh
if [ "$1" = "reload-or-restart" ] && [ "$2" = "caddy" ]; then
  echo "caddy did not restart" >&2
  exit 42
fi
exit 0
`)

	originalPrepare := prepareCaddyPathsFunc
	prepareCaddyPathsFunc = func(context.Context) error { return nil }
	t.Cleanup(func() { prepareCaddyPathsFunc = originalPrepare })

	err := ensureCaddy(context.Background(), nil)
	if err == nil {
		t.Fatal("ensureCaddy returned nil; want reload-or-restart caddy failure")
	}
	if !strings.Contains(err.Error(), "reload-or-restart caddy") {
		t.Fatalf("ensureCaddy error = %q, want reload-or-restart caddy context", err)
	}
}

func TestEnsureDeploymentNetworkHardeningRunsFirewallAndMetadataBlock(t *testing.T) {
	binDir, logPath := prependFakeBin(t)
	writeExecutable(t, binDir, "apt-get", "#!/bin/sh\necho \"apt-get $*\" >> \"$CALL_LOG\"\nexit 0\n")
	writeExecutable(t, binDir, "debconf-set-selections", "#!/bin/sh\necho \"debconf-set-selections\" >> \"$CALL_LOG\"\nexit 0\n")
	writeExecutable(t, binDir, "systemctl", "#!/bin/sh\necho \"systemctl $*\" >> \"$CALL_LOG\"\nexit 0\n")

	firewallScript := writeExecutable(t, t.TempDir(), "setup-firewall.sh", "#!/bin/sh\necho firewall-script >> \"$CALL_LOG\"\nexit 0\n")
	originalPath := firewallSetupScriptPath
	firewallSetupScriptPath = firewallScript
	t.Cleanup(func() { firewallSetupScriptPath = originalPath })

	if err := ensureDeploymentNetworkHardening(context.Background(), nil); err != nil {
		t.Fatalf("ensureDeploymentNetworkHardening: %v", err)
	}

	calls := readCallLog(t, logPath)
	for _, want := range []string{
		"debconf-set-selections",
		"apt-get install -y iptables-persistent",
		"firewall-script",
		"systemctl daemon-reload",
		"systemctl enable --now sam-metadata-block.service",
	} {
		if !strings.Contains(calls, want) {
			t.Fatalf("call log missing %q; calls:\n%s", want, calls)
		}
	}
}

func TestEnsureDeploymentNetworkHardeningContinuesWhenPersistenceInstallUnavailable(t *testing.T) {
	binDir, logPath := prependFakeBin(t)
	writeExecutable(t, binDir, "apt-get", `#!/bin/sh
echo "apt-get $*" >> "$CALL_LOG"
if [ "$1" = "install" ] && [ "$2" = "-y" ] && [ "$3" = "iptables-persistent" ]; then
  echo "Package iptables-persistent is not available" >&2
  exit 100
fi
exit 0
`)
	writeExecutable(t, binDir, "debconf-set-selections", "#!/bin/sh\necho \"debconf-set-selections\" >> \"$CALL_LOG\"\nexit 0\n")
	writeExecutable(t, binDir, "systemctl", "#!/bin/sh\necho \"systemctl $*\" >> \"$CALL_LOG\"\nexit 0\n")

	firewallScript := writeExecutable(t, t.TempDir(), "setup-firewall.sh", "#!/bin/sh\necho firewall-script >> \"$CALL_LOG\"\nexit 0\n")
	originalPath := firewallSetupScriptPath
	firewallSetupScriptPath = firewallScript
	t.Cleanup(func() { firewallSetupScriptPath = originalPath })

	if err := ensureDeploymentNetworkHardening(context.Background(), nil); err != nil {
		t.Fatalf("ensureDeploymentNetworkHardening: %v", err)
	}

	calls := readCallLog(t, logPath)
	for _, want := range []string{
		"apt-get install -y iptables-persistent",
		"firewall-script",
		"systemctl daemon-reload",
		"systemctl enable --now sam-metadata-block.service",
	} {
		if !strings.Contains(calls, want) {
			t.Fatalf("call log missing %q; calls:\n%s", want, calls)
		}
	}
}

func TestEnsureDeploymentNetworkHardeningReturnsFirewallScriptFailure(t *testing.T) {
	binDir, _ := prependFakeBin(t)
	writeExecutable(t, binDir, "apt-get", "#!/bin/sh\nexit 0\n")
	writeExecutable(t, binDir, "debconf-set-selections", "#!/bin/sh\nexit 0\n")
	writeExecutable(t, binDir, "systemctl", "#!/bin/sh\nexit 0\n")

	firewallScript := writeExecutable(t, t.TempDir(), "setup-firewall.sh", "#!/bin/sh\necho firewall failed >&2\nexit 23\n")
	originalPath := firewallSetupScriptPath
	firewallSetupScriptPath = firewallScript
	t.Cleanup(func() { firewallSetupScriptPath = originalPath })

	err := ensureDeploymentNetworkHardening(context.Background(), nil)
	if err == nil {
		t.Fatal("ensureDeploymentNetworkHardening returned nil; want firewall script failure")
	}
	if !strings.Contains(err.Error(), "run firewall setup script") {
		t.Fatalf("ensureDeploymentNetworkHardening error = %q, want firewall script context", err)
	}
}

func TestEnsureDeploymentNetworkHardeningFailsWhenFirewallScriptIsMissing(t *testing.T) {
	originalPath := firewallSetupScriptPath
	firewallSetupScriptPath = filepath.Join(t.TempDir(), "missing-firewall.sh")
	t.Cleanup(func() { firewallSetupScriptPath = originalPath })

	err := ensureDeploymentNetworkHardening(context.Background(), nil)
	if err == nil {
		t.Fatal("ensureDeploymentNetworkHardening returned nil; want missing script error")
	}
	if !strings.Contains(err.Error(), "firewall setup script missing") {
		t.Fatalf("ensureDeploymentNetworkHardening error = %q, want missing script context", err)
	}
}
