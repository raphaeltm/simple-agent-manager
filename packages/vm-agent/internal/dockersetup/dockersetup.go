// Package dockersetup provisions the host-level Docker tooling required for
// Docker Model Runner compose files: a modern Docker Compose v2 plugin (v2.35+,
// which is the first release that accepts `provider:` services) and the
// `docker model` CLI plugin + Model Runner daemon.
//
// This logic is shared by two callers that both prepare hosts to run compose
// files with Model Runner `provider: {type: model}` services:
//   - internal/provision: workspace-node provisioning (build-and-publish host)
//   - internal/deploy: deployment-node runtime bootstrap (where releases apply)
//
// Keeping a single implementation guarantees both paths upgrade to the same
// compose version and install the runner the same way. Both helpers are
// idempotent and non-fatal by contract: callers log-and-continue on failure so
// that ordinary (non-Model-Runner) deploys still proceed.
package dockersetup

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"

	"github.com/workspace/vm-agent/internal/container"
)

// defaultComposeVersion is the Docker Compose v2 plugin release installed when
// the host's plugin is too old. v2.35+ is required for Docker Model Runner
// `provider:` services; we pin a known-good newer release. Overridable via
// SAM_DOCKER_COMPOSE_VERSION (Constitution Principle XI — no hardcoded values).
const defaultComposeVersion = "v2.40.3"

// minComposeMinor is the minimum compose v2 minor version (major == 2) that
// accepts Model Runner `provider:` services. Below this, `docker compose config`
// errors with "Additional property provider is not allowed".
const minComposeMinor = 35

func targetComposeVersion() string {
	if v := strings.TrimSpace(os.Getenv("SAM_DOCKER_COMPOSE_VERSION")); v != "" {
		return v
	}
	return defaultComposeVersion
}

// EnsureModernCompose installs a compose v2 plugin into the local cli-plugins
// directory (which takes precedence over the apt-installed plugin) when the
// host's current plugin predates `provider:` support. No-op if already modern.
func EnsureModernCompose(ctx context.Context) error {
	if major, minor, ok := composeMajorMinor(ctx); ok {
		if composeSupportsProvider(major, minor) {
			slog.Info("dockersetup: compose plugin already modern", "version", fmt.Sprintf("%d.%d", major, minor))
			return nil
		}
		slog.Info("dockersetup: compose plugin too old, upgrading",
			"current", fmt.Sprintf("%d.%d", major, minor), "target", targetComposeVersion())
	} else {
		slog.Info("dockersetup: compose plugin not detected, installing", "target", targetComposeVersion())
	}

	arch := composeArch()
	if arch == "" {
		return fmt.Errorf("unsupported architecture for compose upgrade: %s", runtime.GOARCH)
	}

	version := targetComposeVersion()
	url := fmt.Sprintf(
		"https://github.com/docker/compose/releases/download/%s/docker-compose-linux-%s",
		version, arch)
	const dest = "/usr/local/lib/docker/cli-plugins/docker-compose"
	// Download to a temp file then atomically move into place so a partial
	// download can never leave a broken plugin on PATH.
	script := fmt.Sprintf(
		"mkdir -p /usr/local/lib/docker/cli-plugins && "+
			"curl -fsSL --retry 3 -o %[1]s.tmp %[2]q && "+
			"chmod +x %[1]s.tmp && "+
			"mv -f %[1]s.tmp %[1]s",
		dest, url)
	if err := runShell(ctx, script); err != nil {
		return fmt.Errorf("compose plugin download failed: %w", err)
	}

	major, minor, ok := composeMajorMinor(ctx)
	if !ok {
		return fmt.Errorf("compose plugin not detected after upgrade")
	}
	if composeSupportsProvider(major, minor) {
		slog.Info("dockersetup: compose plugin upgraded", "version", fmt.Sprintf("%d.%d", major, minor))
		return nil
	}
	return fmt.Errorf("compose plugin still too old after upgrade: %d.%d", major, minor)
}

// composeSupportsProvider reports whether a compose v2 plugin of the given
// major.minor accepts Docker Model Runner `provider:` services (v2.35+).
func composeSupportsProvider(major, minor int) bool {
	return major > 2 || (major == 2 && minor >= minComposeMinor)
}

// composeMajorMinor returns the major and minor version of the installed
// compose v2 plugin (`docker compose version --short`).
func composeMajorMinor(ctx context.Context) (int, int, bool) {
	out, err := exec.CommandContext(ctx, container.DockerCLIPath(), "compose", "version", "--short").Output()
	if err != nil {
		return 0, 0, false
	}
	return parseComposeVersion(string(out))
}

// parseComposeVersion extracts major.minor from a compose version string such
// as "2.40.3", "v2.35.0", or "2.40.3-desktop.1".
func parseComposeVersion(s string) (int, int, bool) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "v")
	parts := strings.SplitN(s, ".", 3)
	if len(parts) < 2 {
		return 0, 0, false
	}
	major, err1 := strconv.Atoi(parts[0])
	minor, err2 := strconv.Atoi(strings.SplitN(parts[1], "-", 2)[0])
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return major, minor, true
}

// composeArch maps GOARCH to the docker/compose release asset suffix.
func composeArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "aarch64"
	default:
		return ""
	}
}

// defaultModelCLIVersion pins the docker/model-cli release used to install the
// `docker model` plugin. Empty means "use the GitHub `latest` release", which
// avoids a guaranteed-stale pin while still being overridable. Override via
// SAM_DOCKER_MODEL_VERSION (e.g. "v0.1.32") for reproducible builds
// (Constitution Principle XI — no hardcoded values).
const defaultModelCLIVersion = ""

func targetModelCLIVersion() string {
	return strings.TrimSpace(os.Getenv("SAM_DOCKER_MODEL_VERSION"))
}

// modelCLIArch maps GOARCH to the docker/model-cli release asset suffix
// (docker-model-linux-<arch>, which uses GOARCH-style names directly).
func modelCLIArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "amd64"
	case "arm64":
		return "arm64"
	default:
		return ""
	}
}

// EnsureDockerModelRunner installs the `docker model` CLI plugin (docker/model-cli)
// and provisions the Model Runner daemon so compose `provider: {type: model}`
// services can run. It is idempotent: if the plugin is already present and the
// runner already installed, both checks short-circuit.
func EnsureDockerModelRunner(ctx context.Context) error {
	// Install the CLI plugin if `docker model` is not already available.
	if err := exec.CommandContext(ctx, container.DockerCLIPath(), "model", "version").Run(); err != nil {
		arch := modelCLIArch()
		if arch == "" {
			return fmt.Errorf("unsupported architecture for model runner: %s", runtime.GOARCH)
		}

		version := targetModelCLIVersion()
		if version == "" {
			version = defaultModelCLIVersion
		}
		var url string
		if version == "" {
			url = fmt.Sprintf(
				"https://github.com/docker/model-cli/releases/latest/download/docker-model-linux-%s",
				arch)
		} else {
			url = fmt.Sprintf(
				"https://github.com/docker/model-cli/releases/download/%s/docker-model-linux-%s",
				version, arch)
		}

		const dest = "/usr/local/lib/docker/cli-plugins/docker-model"
		// Download to a temp file then atomically move into place so a partial
		// download can never leave a broken plugin on PATH.
		script := fmt.Sprintf(
			"mkdir -p /usr/local/lib/docker/cli-plugins && "+
				"curl -fsSL --retry 3 -o %[1]s.tmp %[2]q && "+
				"chmod +x %[1]s.tmp && "+
				"mv -f %[1]s.tmp %[1]s",
			dest, url)
		if err := runShell(ctx, script); err != nil {
			return fmt.Errorf("docker model plugin download failed: %w", err)
		}

		if err := exec.CommandContext(ctx, container.DockerCLIPath(), "model", "version").Run(); err != nil {
			return fmt.Errorf("docker model plugin not usable after install: %w", err)
		}
		slog.Info("dockersetup: docker model plugin installed")
	} else {
		slog.Info("dockersetup: docker model plugin already installed")
	}

	// Provision the Model Runner daemon (runs as a managed container/service).
	// `install-runner` is idempotent — a no-op when the runner already exists.
	if err := runShell(ctx, "docker model install-runner"); err != nil {
		return fmt.Errorf("docker model install-runner failed: %w", err)
	}
	slog.Info("dockersetup: docker model runner provisioned")
	return nil
}

// runShell executes a shell command string. An absolute interpreter path is
// used so the shell is not resolved through a potentially writable PATH
// (go:S4036); these helpers run as root during host provisioning.
func runShell(ctx context.Context, script string) error {
	cmd := exec.CommandContext(ctx, "/bin/bash", "-c", script)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
