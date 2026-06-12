package deploy

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
)

// EnsureRuntime installs and starts the host-level dependencies required for
// deployment apply. It is intentionally small and separate from workspace
// provisioning: deployment nodes need Docker for Compose and Caddy for routing,
// but not Node.js, devcontainer tooling, or workspace bootstrap.
func EnsureRuntime(ctx context.Context) error {
	if err := ensureDocker(ctx); err != nil {
		return err
	}
	if err := ensureCaddy(ctx); err != nil {
		return err
	}
	return nil
}

func ensureDocker(ctx context.Context) error {
	if _, err := exec.LookPath("docker"); err == nil {
		slog.Info("deploy.runtime: docker already installed")
		_ = runRuntimeCommand(ctx, "systemctl", "enable", "docker")
		_ = runRuntimeCommand(ctx, "systemctl", "start", "docker")
		return nil
	}

	slog.Info("deploy.runtime: installing docker")
	if err := runRuntimeShell(ctx, "DEBIAN_FRONTEND=noninteractive apt-get update -qq && "+
		"DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose"); err != nil {
		return fmt.Errorf("install docker: %w", err)
	}
	if err := runRuntimeCommand(ctx, "systemctl", "enable", "docker"); err != nil {
		return fmt.Errorf("enable docker: %w", err)
	}
	if err := runRuntimeCommand(ctx, "systemctl", "start", "docker"); err != nil {
		return fmt.Errorf("start docker: %w", err)
	}
	return nil
}

func ensureCaddy(ctx context.Context) error {
	if _, err := exec.LookPath("caddy"); err == nil {
		slog.Info("deploy.runtime: caddy already installed")
		if err := prepareCaddyPaths(ctx); err != nil {
			return err
		}
		_ = runRuntimeCommand(ctx, "systemctl", "enable", "caddy")
		_ = runRuntimeCommand(ctx, "systemctl", "reload-or-restart", "caddy")
		return nil
	}

	slog.Info("deploy.runtime: installing caddy")
	script := `
set -euo pipefail
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gpg curl
install -d -m 0755 /usr/share/keyrings
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy
id caddy >/dev/null
mkdir -p /etc/caddy /var/lib/caddy /var/log/caddy
chown -R caddy:caddy /var/lib/caddy /var/log/caddy
systemctl enable caddy
systemctl reload-or-restart caddy
`
	if err := runRuntimeShell(ctx, script); err != nil {
		return fmt.Errorf("install caddy: %w", err)
	}
	return nil
}

func prepareCaddyPaths(ctx context.Context) error {
	script := `
set -euo pipefail
id caddy >/dev/null
mkdir -p /etc/caddy /var/lib/caddy /var/log/caddy
chown -R caddy:caddy /var/lib/caddy /var/log/caddy
`
	if err := runRuntimeShell(ctx, script); err != nil {
		return fmt.Errorf("prepare caddy paths: %w", err)
	}
	return nil
}

func runRuntimeCommand(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %v: %w (output: %s)", name, args, err, string(output))
	}
	return nil
}

func runRuntimeShell(ctx context.Context, script string) error {
	cmd := exec.CommandContext(ctx, "bash", "-c", script)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("bash -c: %w (output: %s)", err, string(output))
	}
	return nil
}
