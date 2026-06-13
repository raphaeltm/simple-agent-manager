package deploy

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"

	"github.com/workspace/vm-agent/internal/errorreport"
)

const runtimeReportSource = "deploy.runtime"

// EnsureRuntime installs and starts the host-level dependencies required for
// deployment apply. It is intentionally small and separate from workspace
// provisioning: deployment nodes need Docker for Compose and Caddy for routing,
// but not Node.js, devcontainer tooling, or workspace bootstrap.
//
// EnsureRuntime runs before the agent's HTTP server and heartbeat loop start,
// so the only telemetry channel available during install is the reporter, which
// POSTs to the control plane's node-error endpoint. The reporter is nil-safe.
func EnsureRuntime(ctx context.Context, reporter *errorreport.Reporter) error {
	reporter.ReportInfo("deploy.runtime: ensuring host dependencies (docker, caddy)", runtimeReportSource, "", nil)
	if err := ensureDocker(ctx, reporter); err != nil {
		reporter.ReportError(err, runtimeReportSource, "", map[string]interface{}{"step": "ensure_docker"})
		return err
	}
	if err := ensureCaddy(ctx, reporter); err != nil {
		reporter.ReportError(err, runtimeReportSource, "", map[string]interface{}{"step": "ensure_caddy"})
		return err
	}
	reporter.ReportInfo("deploy.runtime: host dependencies ready", runtimeReportSource, "", nil)
	return nil
}

func ensureDocker(ctx context.Context, reporter *errorreport.Reporter) error {
	if _, err := exec.LookPath("docker"); err == nil {
		slog.Info("deploy.runtime: docker already installed")
		reporter.ReportInfo("deploy.runtime: docker already installed; ensuring service is running", runtimeReportSource, "", nil)
		_ = runRuntimeCommand(ctx, "systemctl", "enable", "docker")
		_ = runRuntimeCommand(ctx, "systemctl", "start", "docker")
		return nil
	}

	slog.Info("deploy.runtime: installing docker")
	reporter.ReportInfo("deploy.runtime: installing docker via apt", runtimeReportSource, "", nil)
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
	reporter.ReportInfo("deploy.runtime: docker installed and started", runtimeReportSource, "", nil)
	return nil
}

func ensureCaddy(ctx context.Context, reporter *errorreport.Reporter) error {
	if _, err := exec.LookPath("caddy"); err == nil {
		slog.Info("deploy.runtime: caddy already installed")
		reporter.ReportInfo("deploy.runtime: caddy already installed; preparing paths and starting service", runtimeReportSource, "", nil)
		if err := prepareCaddyPaths(ctx); err != nil {
			return err
		}
		_ = runRuntimeCommand(ctx, "systemctl", "enable", "caddy")
		_ = runRuntimeCommand(ctx, "systemctl", "reload-or-restart", "caddy")
		return nil
	}

	slog.Info("deploy.runtime: installing caddy")
	reporter.ReportInfo("deploy.runtime: installing caddy via apt repository", runtimeReportSource, "", nil)
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
	reporter.ReportInfo("deploy.runtime: caddy installed and started", runtimeReportSource, "", nil)
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
