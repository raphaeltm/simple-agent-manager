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
	// A usable Caddy runtime needs three things: the binary, the `caddy` system
	// user (file ownership + the systemd unit's User= directive resolve to it),
	// and a caddy systemd unit. The `docker-ce` Hetzner base image can leave the
	// caddy binary on PATH WITHOUT the user or service unit. Control-plane
	// telemetry caught this directly: the old fast path trusted a bare
	// `exec.LookPath("caddy")` success, then aborted in prepareCaddyPaths on
	// `id caddy` -> "id: 'caddy': no such user", returning an error that crashed
	// the agent into a systemd restart loop before the server ever started.
	// Only take the fast path when all three pieces are present; otherwise fall
	// through to the apt install, whose package postinst creates the user, unit,
	// and config idempotently.
	if caddyRuntimeReady(ctx) {
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
# Cloud-init pre-writes /etc/caddy/Caddyfile so Caddy can start cleanly before
# the first deploy apply. The caddy .deb ships its own Caddyfile as a dpkg
# conffile, so the postinst hits a conffile conflict and, under noninteractive
# apt, exits 100 (telemetry caught: "Configuration file '/etc/caddy/Caddyfile'
# ... exit status 100"). Force-keep the on-disk version: the deploy engine
# overwrites this file via GenerateCaddyfile on apply anyway, so the bootstrap
# contents are disposable — all that matters is the install completing.
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  -o Dpkg::Options::="--force-confold" -o Dpkg::Options::="--force-confdef" caddy
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

// caddyRuntimeReady reports whether a usable Caddy runtime is already present:
// the binary on PATH, the `caddy` system user, and a caddy systemd unit. Any
// missing piece means the apt install must run to create them — a bare binary
// is not enough to serve routes or own the runtime directories.
func caddyRuntimeReady(ctx context.Context) bool {
	if _, err := exec.LookPath("caddy"); err != nil {
		return false
	}
	if err := runRuntimeCommand(ctx, "id", "caddy"); err != nil {
		return false
	}
	if err := runRuntimeCommand(ctx, "systemctl", "cat", "caddy"); err != nil {
		return false
	}
	return true
}

func prepareCaddyPaths(ctx context.Context) error {
	// The caller (ensureCaddy fast path) only reaches here after caddyRuntimeReady
	// has confirmed the caddy user exists, so the chown target is guaranteed to
	// resolve. No `id caddy` guard here — that guard previously aborted the whole
	// script under `set -e` when the user was missing.
	script := `
set -euo pipefail
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
	// Use an absolute path so the shell is not resolved through a potentially
	// writable PATH (go:S4036). The deployment runtime runs as root during
	// provisioning; /bin/bash is the fixed, root-owned interpreter location.
	cmd := exec.CommandContext(ctx, "/bin/bash", "-c", script)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("bash -c: %w (output: %s)", err, string(output))
	}
	return nil
}
