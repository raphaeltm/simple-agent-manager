// Package provision handles system-level provisioning that was previously done
// by cloud-init. By running these steps inside the vm-agent, we get:
//   - Immediate heartbeats (agent starts in ~30s instead of 8-12 min)
//   - Full observability via the eventstore (every step is logged + downloadable)
//   - Better error handling (retries, fallbacks, structured logging)
package provision

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/eventstore"
)

// eventID returns a random hex ID for eventstore primary keys.
// Using an empty ID collides with INSERT OR IGNORE and silently drops
// subsequent events, which masked phase timings on the first staging test.
func eventID() string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// Status tracks the progress of system provisioning.
type Status struct {
	mu          sync.RWMutex
	Phase       string    `json:"phase"`
	StartedAt   time.Time `json:"startedAt"`
	CompletedAt time.Time `json:"completedAt,omitempty"`
	Error       string    `json:"error,omitempty"`
	Steps       []Step    `json:"steps"`
}

// StatusSnapshot is a lock-free copy of provisioning status for callers.
type StatusSnapshot struct {
	Phase       string    `json:"phase"`
	StartedAt   time.Time `json:"startedAt"`
	CompletedAt time.Time `json:"completedAt,omitempty"`
	Error       string    `json:"error,omitempty"`
	Steps       []Step    `json:"steps"`
}

// Step represents one provisioning step.
type Step struct {
	Name        string    `json:"name"`
	Status      string    `json:"status"` // pending, running, completed, failed, skipped
	StartedAt   time.Time `json:"startedAt,omitempty"`
	CompletedAt time.Time `json:"completedAt,omitempty"`
	DurationMs  int64     `json:"durationMs,omitempty"`
	Error       string    `json:"error,omitempty"`
}

func (s *Status) setStep(name, status string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.Steps {
		if s.Steps[i].Name == name {
			s.Steps[i].Status = status
			if status == "running" {
				s.Steps[i].StartedAt = time.Now()
			}
			if status == "completed" || status == "failed" {
				s.Steps[i].CompletedAt = time.Now()
				if !s.Steps[i].StartedAt.IsZero() {
					s.Steps[i].DurationMs = time.Since(s.Steps[i].StartedAt).Milliseconds()
				}
			}
			return
		}
	}
}

func (s *Status) setStepError(name, errMsg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.Steps {
		if s.Steps[i].Name == name {
			s.Steps[i].Error = errMsg
			return
		}
	}
}

// GetStatus returns a snapshot of the current provisioning status.
func (s *Status) GetStatus() StatusSnapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cp := StatusSnapshot{
		Phase:       s.Phase,
		StartedAt:   s.StartedAt,
		CompletedAt: s.CompletedAt,
		Error:       s.Error,
		Steps:       make([]Step, len(s.Steps)),
	}
	copy(cp.Steps, s.Steps)
	return cp
}

// Config holds provisioning configuration.
type Config struct {
	// VMAgentPort is the port the vm-agent listens on (for firewall rules).
	VMAgentPort string
	// CFIPFetchTimeout is the timeout in seconds for fetching Cloudflare IPs.
	CFIPFetchTimeout string
	// SkipFirewall skips firewall setup (for testing).
	SkipFirewall bool
	// SkipNodeJS skips Node.js installation (if already present).
	SkipNodeJS bool
	// SkipDocker skips Docker installation (for testing).
	SkipDocker bool
}

// Run executes all system provisioning steps. It is safe to call from a goroutine.
// Each step is logged to the eventstore for observability.
func Run(ctx context.Context, cfg Config, es *eventstore.Store) (*Status, error) {
	status := &Status{
		Phase:     "running",
		StartedAt: time.Now(),
		Steps: []Step{
			{Name: "packages", Status: "pending"},
			{Name: "docker", Status: "pending"},
			{Name: "firewall", Status: "pending"},
			{Name: "tls-permissions", Status: "pending"},
			{Name: "nodejs-install", Status: "pending"},
			{Name: "devcontainer-cli", Status: "pending"},
			{Name: "image-prepull", Status: "pending"},
			{Name: "journald-config", Status: "pending"},
			{Name: "docker-restart", Status: "pending"},
			{Name: "metadata-block", Status: "pending"},
		},
	}

	logStep := func(name, stepStatus, msg string, durationMs int64) {
		slog.Info("provision: "+msg, "step", name, "status", stepStatus)
		if es != nil {
			detail := map[string]interface{}{
				"step":   name,
				"status": stepStatus,
			}
			if durationMs > 0 {
				detail["durationMs"] = durationMs
			}
			es.Append(eventstore.EventRecord{
				ID:        eventID(),
				Level:     "info",
				Type:      "provision." + name,
				Message:   msg,
				Detail:    detail,
				CreatedAt: time.Now().UTC().Format(time.RFC3339),
			})
		}
	}

	runStep := func(name string, fn func(context.Context) error) error {
		status.setStep(name, "running")
		logStep(name, "started", "Starting "+name, 0)
		start := time.Now()

		if err := fn(ctx); err != nil {
			elapsed := time.Since(start)
			status.setStep(name, "failed")
			status.setStepError(name, err.Error())
			logStep(name, "failed", fmt.Sprintf("%s failed after %s: %s", name, elapsed.Round(time.Millisecond), err), elapsed.Milliseconds())
			return fmt.Errorf("provision step %s failed: %w", name, err)
		}

		elapsed := time.Since(start)
		status.setStep(name, "completed")
		logStep(name, "completed", fmt.Sprintf("%s completed in %s", name, elapsed.Round(time.Millisecond)), elapsed.Milliseconds())
		return nil
	}

	// Step 1: Install basic packages (git, jq, etc.)
	if err := runStep("packages", func(ctx context.Context) error {
		return installPackages(ctx)
	}); err != nil {
		slog.Warn("Package installation failed, continuing", "error", err)
	}

	// Step 2: Docker install + start (needed for devcontainers)
	if !cfg.SkipDocker {
		if err := runStep("docker", func(ctx context.Context) error {
			return installDocker(ctx)
		}); err != nil {
			// Docker failure is fatal — everything depends on it
			status.Phase = "failed"
			status.Error = err.Error()
			return status, err
		}
	} else {
		status.setStep("docker", "skipped")
	}

	// Step 2b: Ensure a modern Docker Compose plugin. The Hetzner docker-ce base
	// image (and the docker.io apt fallback) ship a compose plugin older than
	// v2.35, which rejects Docker Model Runner `provider:` services during
	// `docker compose config` — breaking host-side build-and-publish for Model
	// Runner compose files. Upgrade is non-fatal: a too-old plugin only affects
	// the newer compose schema, so ordinary deploys still work if this fails.
	if !cfg.SkipDocker {
		if err := runStep("compose-plugin", func(ctx context.Context) error {
			return ensureModernCompose(ctx)
		}); err != nil {
			slog.Warn("Docker Compose plugin upgrade failed, continuing", "error", err)
		}
	} else {
		status.setStep("compose-plugin", "skipped")
	}

	// Step 3: Firewall (needed for Cloudflare-only access to vm-agent port)
	if !cfg.SkipFirewall {
		if err := runStep("firewall", func(ctx context.Context) error {
			return installFirewall(ctx, cfg.VMAgentPort, cfg.CFIPFetchTimeout)
		}); err != nil {
			slog.Warn("Firewall setup failed, continuing without firewall", "error", err)
		}
		// Flush any pooled control-plane sockets: firewall install can break
		// in-flight connections without closing them, leaving dead sockets
		// in the Go transport pool for up to IdleConnTimeout (30s post-fix).
		config.CloseIdleControlPlaneConnections()
	} else {
		status.setStep("firewall", "skipped")
	}

	// Step 4: TLS key permissions
	if err := runStep("tls-permissions", func(_ context.Context) error {
		return hardenTLSPermissions()
	}); err != nil {
		slog.Warn("TLS permission hardening failed, continuing", "error", err)
	}

	// Step 5: Node.js install (needed for devcontainer CLI)
	if !cfg.SkipNodeJS {
		if err := runStep("nodejs-install", func(ctx context.Context) error {
			return installNodeJS(ctx)
		}); err != nil {
			// Node.js failure is fatal — devcontainer CLI needs it
			status.Phase = "failed"
			status.Error = err.Error()
			return status, err
		}
	} else {
		status.setStep("nodejs-install", "skipped")
	}

	// Step 6: devcontainer CLI
	if err := runStep("devcontainer-cli", func(ctx context.Context) error {
		return installDevcontainerCLI(ctx)
	}); err != nil {
		status.Phase = "failed"
		status.Error = err.Error()
		return status, err
	}

	// Step 7: Base image pre-pull (background — don't block)
	var pullWg sync.WaitGroup
	pullWg.Add(1)
	go func() {
		defer pullWg.Done()
		status.setStep("image-prepull", "running")
		logStep("image-prepull", "started", "Starting base image pre-pull (background)", 0)
		start := time.Now()
		if err := pullBaseImage(ctx); err != nil {
			elapsed := time.Since(start)
			status.setStep("image-prepull", "failed")
			status.setStepError("image-prepull", err.Error())
			logStep("image-prepull", "failed", fmt.Sprintf("Image pre-pull failed after %s: %s", elapsed.Round(time.Millisecond), err), elapsed.Milliseconds())
		} else {
			elapsed := time.Since(start)
			status.setStep("image-prepull", "completed")
			logStep("image-prepull", "completed", fmt.Sprintf("Image pre-pull completed in %s", elapsed.Round(time.Millisecond)), elapsed.Milliseconds())
		}
	}()

	// Step 8: Journald config
	if err := runStep("journald-config", func(_ context.Context) error {
		return restartJournald()
	}); err != nil {
		slog.Warn("Journald restart failed, continuing", "error", err)
	}

	// Wait for image pull before Docker restart (restart kills in-progress pulls)
	pullWg.Wait()

	// Step 9: Docker restart (picks up journald log driver + DNS config)
	if err := runStep("docker-restart", func(ctx context.Context) error {
		return restartDocker(ctx)
	}); err != nil {
		slog.Warn("Docker restart failed, continuing", "error", err)
	}
	// Flush any pooled control-plane sockets: Docker restart recreates the
	// docker0/veth bridges and invalidates nf_conntrack entries, which can
	// silently break pooled TCP connections to the control plane.
	config.CloseIdleControlPlaneConnections()

	// Step 10: Metadata block service
	if err := runStep("metadata-block", func(ctx context.Context) error {
		return enableMetadataBlock(ctx)
	}); err != nil {
		slog.Warn("Metadata block setup failed, continuing", "error", err)
	}

	status.Phase = "completed"
	status.CompletedAt = time.Now()
	totalElapsed := time.Since(status.StartedAt)
	logStep("all", "completed", fmt.Sprintf("System provisioning completed in %s", totalElapsed.Round(time.Millisecond)), totalElapsed.Milliseconds())

	return status, nil
}

// runCommand executes a shell command and returns combined output on failure.
func runCommand(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// runShell executes a shell command string.
func runShell(ctx context.Context, script string) error {
	cmd := exec.CommandContext(ctx, "bash", "-c", script)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func installPackages(ctx context.Context) error {
	// Install basic utilities needed for provisioning and workspace operations.
	// Docker is handled separately in installDocker().
	return runShell(ctx, "DEBIAN_FRONTEND=noninteractive apt-get update -qq && "+
		"DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl wget jq htop vim")
}

func installDocker(ctx context.Context) error {
	// Check if already installed
	if _, err := exec.LookPath("docker"); err == nil {
		slog.Info("Docker already installed")
		// Just make sure it's running
		_ = runCommand(ctx, "systemctl", "enable", "docker")
		_ = runCommand(ctx, "systemctl", "start", "docker")
		return nil
	}

	if err := runShell(ctx, "DEBIAN_FRONTEND=noninteractive apt-get update -qq && "+
		"DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose"); err != nil {
		return fmt.Errorf("docker install failed: %w", err)
	}

	if err := runCommand(ctx, "systemctl", "enable", "docker"); err != nil {
		return fmt.Errorf("docker enable failed: %w", err)
	}
	if err := runCommand(ctx, "systemctl", "start", "docker"); err != nil {
		return fmt.Errorf("docker start failed: %w", err)
	}

	// Add workspace user to docker group
	_ = runCommand(ctx, "usermod", "-aG", "docker", "workspace")

	return nil
}

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

// ensureModernCompose installs a compose v2 plugin into the local cli-plugins
// directory (which takes precedence over the apt-installed plugin) when the
// host's current plugin predates `provider:` support. No-op if already modern.
func ensureModernCompose(ctx context.Context) error {
	if major, minor, ok := composeMajorMinor(ctx); ok {
		if composeSupportsProvider(major, minor) {
			slog.Info("Docker Compose plugin already modern", "version", fmt.Sprintf("%d.%d", major, minor))
			return nil
		}
		slog.Info("Docker Compose plugin too old, upgrading",
			"current", fmt.Sprintf("%d.%d", major, minor), "target", targetComposeVersion())
	} else {
		slog.Info("Docker Compose plugin not detected, installing", "target", targetComposeVersion())
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
		slog.Info("Docker Compose plugin upgraded", "version", fmt.Sprintf("%d.%d", major, minor))
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
	out, err := exec.CommandContext(ctx, "docker", "compose", "version", "--short").Output()
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

func installFirewall(ctx context.Context, vmAgentPort, cfIPFetchTimeout string) error {
	// Install iptables-persistent
	if err := runShell(ctx, `echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections && `+
		`echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections && `+
		`DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent`); err != nil {
		return fmt.Errorf("iptables-persistent install failed: %w", err)
	}

	// Run the firewall setup script (written by cloud-init write_files)
	if _, err := os.Stat("/etc/sam/firewall/setup-firewall.sh"); err == nil {
		if err := runCommand(ctx, "/etc/sam/firewall/setup-firewall.sh"); err != nil {
			return fmt.Errorf("firewall setup script failed: %w", err)
		}
	} else {
		slog.Warn("Firewall script not found, skipping", "path", "/etc/sam/firewall/setup-firewall.sh")
	}

	return nil
}

func hardenTLSPermissions() error {
	keyPath := "/etc/sam/tls/origin-ca-key.pem"
	if _, err := os.Stat(keyPath); err != nil {
		return nil // No key file, nothing to do
	}
	if err := os.Chmod(keyPath, 0600); err != nil {
		return fmt.Errorf("chmod failed: %w", err)
	}
	// chown to root:root
	if err := os.Chown(keyPath, 0, 0); err != nil {
		return fmt.Errorf("chown failed: %w", err)
	}
	return nil
}

func installNodeJS(ctx context.Context) error {
	// Check if already installed
	if path, err := exec.LookPath("node"); err == nil {
		out, _ := exec.CommandContext(ctx, path, "--version").Output()
		slog.Info("Node.js already installed", "version", strings.TrimSpace(string(out)))
		return nil
	}

	if err := runShell(ctx, "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"); err != nil {
		return fmt.Errorf("nodesource setup failed: %w", err)
	}
	if err := runShell(ctx, "apt-get install -y nodejs"); err != nil {
		return fmt.Errorf("nodejs install failed: %w", err)
	}
	return nil
}

func installDevcontainerCLI(ctx context.Context) error {
	// Check if already installed
	if _, err := exec.LookPath("devcontainer"); err == nil {
		slog.Info("devcontainer CLI already installed")
		return nil
	}

	if err := runShell(ctx, "npm install -g @devcontainers/cli"); err != nil {
		return fmt.Errorf("devcontainer CLI install failed: %w", err)
	}
	return nil
}

func pullBaseImage(ctx context.Context) error {
	return runShell(ctx, "docker pull "+config.DefaultDevcontainerImage)
}

func restartJournald() error {
	if err := os.MkdirAll("/etc/systemd/journald.conf.d", 0755); err != nil {
		return err
	}
	cmd := exec.Command("systemctl", "restart", "systemd-journald")
	return cmd.Run()
}

func restartDocker(ctx context.Context) error {
	return runCommand(ctx, "systemctl", "restart", "docker")
}

func enableMetadataBlock(ctx context.Context) error {
	if err := runCommand(ctx, "systemctl", "daemon-reload"); err != nil {
		return err
	}
	return runCommand(ctx, "systemctl", "enable", "--now", "sam-metadata-block.service")
}
