package deploy

import (
	"context"
	"log/slog"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// caddyAdminURL is the local admin API endpoint Caddy exposes when its service
// is running. `caddy reload` talks to this endpoint, so its reachability is the
// authoritative signal that the Caddy daemon is actually up — a present binary
// on PATH is not sufficient.
const caddyAdminURL = "http://127.0.0.1:2019/config/"

// LogPreflight runs non-fatal environment checks at deployment-mode startup and
// logs the results so the next boot is self-diagnosing via journalctl. It never
// returns an error: its sole purpose is observability. The checks mirror the
// exact dependencies the apply path relies on (docker daemon, docker compose,
// the caddy binary, and a *running* caddy admin API), so a failed deploy can be
// triaged from logs alone instead of an interactive SSH session.
func (e *Engine) LogPreflight(ctx context.Context) {
	composeParts := strings.Fields(e.cfg.ComposeCmd)
	dockerBin := "docker"
	if len(composeParts) > 0 {
		dockerBin = composeParts[0]
	}

	// 1. docker (or configured runtime) binary on PATH.
	if path, err := exec.LookPath(dockerBin); err != nil {
		slog.Error("deploy preflight: container runtime binary not found on PATH",
			"binary", dockerBin, "error", err)
	} else {
		slog.Info("deploy preflight: container runtime binary present", "binary", dockerBin, "path", path)
	}

	// 2. docker daemon reachable.
	if out, err := e.runPreflightCmd(ctx, dockerBin, "info", "--format", "{{.ServerVersion}}"); err != nil {
		slog.Error("deploy preflight: container runtime daemon not reachable",
			"binary", dockerBin, "error", err, "output", strings.TrimSpace(out))
	} else {
		slog.Info("deploy preflight: container runtime daemon reachable", "serverVersion", strings.TrimSpace(out))
	}

	// 3. docker compose subcommand usable.
	if len(composeParts) > 0 {
		args := append(composeParts[1:], "version")
		if out, err := e.runPreflightCmd(ctx, composeParts[0], args...); err != nil {
			slog.Error("deploy preflight: compose command not usable",
				"command", e.cfg.ComposeCmd, "error", err, "output", strings.TrimSpace(out))
		} else {
			slog.Info("deploy preflight: compose command usable", "version", strings.TrimSpace(out))
		}
	}

	// 4. caddy reload binary on PATH.
	reloadParts := strings.Fields(e.cfg.CaddyReloadCmd)
	if len(reloadParts) > 0 {
		if path, err := exec.LookPath(reloadParts[0]); err != nil {
			slog.Error("deploy preflight: caddy binary not found on PATH",
				"binary", reloadParts[0], "error", err)
		} else {
			slog.Info("deploy preflight: caddy binary present", "binary", reloadParts[0], "path", path)
		}
	}

	// 5. caddy admin API reachable (i.e. the caddy service is actually running).
	// This is the most common silent failure: the binary exists but the systemd
	// unit never started, so `caddy reload` fails at apply time with a connection
	// error that today is only logged at the apply site.
	if e.caddyAdminReachable(ctx) {
		slog.Info("deploy preflight: caddy admin API reachable (service running)", "url", caddyAdminURL)
	} else {
		slog.Error("deploy preflight: caddy admin API NOT reachable — caddy service is likely not running; "+
			"`caddy reload` will fail at apply time", "url", caddyAdminURL)
	}
}

// runPreflightCmd runs a short diagnostic command with a bounded timeout and
// returns its combined output. Errors are returned for the caller to log.
func (e *Engine) runPreflightCmd(ctx context.Context, name string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, name, args...).CombinedOutput()
	return string(out), err
}

// caddyAdminReachable reports whether the local Caddy admin API answers, which
// indicates the caddy service is running and able to accept a config reload.
func (e *Engine) caddyAdminReachable(ctx context.Context) bool {
	return e.reachable(ctx, caddyAdminURL)
}

// reachable performs a bounded GET and reports whether the endpoint answers with
// a non-5xx status. Connection errors (nothing listening) report false.
func (e *Engine) reachable(ctx context.Context, url string) bool {
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode < 500
}
