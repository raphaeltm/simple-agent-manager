package browser

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
)

// generateRandomPassword creates a cryptographically random hex password.
func generateRandomPassword(byteLen int) (string, error) {
	buf := make([]byte, byteLen)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("failed to generate random password: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// buildNekoEnv generates environment variable flags for the Neko container.
func buildNekoEnv(resolution string, maxFPS, nekoPort int, password, passwordAdmin string, enableAudio, tcpFallback bool) []string {
	env := []string{
		fmt.Sprintf("NEKO_SCREEN=%s@%d", resolution, maxFPS),
		// Neko passwords — per-container random credentials for defense-in-depth.
		// SAM handles auth at the proxy layer; these are set for Neko's internal requirements.
		fmt.Sprintf("NEKO_PASSWORD=%s", password),
		fmt.Sprintf("NEKO_PASSWORD_ADMIN=%s", passwordAdmin),
		// Bind to all interfaces on the configured port so it's reachable from the Docker network.
		fmt.Sprintf("NEKO_BIND=:%d", nekoPort),
	}

	if !enableAudio {
		env = append(env, "NEKO_AUDIO=false")
	}

	if tcpFallback {
		// Use TCP fallback for WebRTC — works through existing HTTP proxy.
		env = append(env, "NEKO_ICELITE=true")
	}

	return env
}

// ResourceLimits configures Docker resource constraints for the Neko container.
type ResourceLimits struct {
	MemoryLimit string // e.g. "4g"
	CPULimit    string // e.g. "2"
	PidsLimit   int    // e.g. 512
}

// buildDockerRunArgs constructs the full `docker run` argument list for the Neko container.
func buildDockerRunArgs(containerName, image, networkName, shmSize string, nekoPort int, envVars []string, limits ResourceLimits) []string {
	args := []string{
		"run", "-d",
		"--name", containerName,
		"--network", networkName,
		fmt.Sprintf("--shm-size=%s", shmSize), // Chrome requires shared memory for rendering
		"--restart", "no",                      // Manager controls lifecycle, not Docker daemon
		"--security-opt", "no-new-privileges",  // Prevent privilege escalation inside container
	}

	// Resource limits
	if limits.MemoryLimit != "" {
		args = append(args, "--memory", limits.MemoryLimit)
	}
	if limits.CPULimit != "" {
		args = append(args, "--cpus", limits.CPULimit)
	}
	if limits.PidsLimit > 0 {
		args = append(args, "--pids-limit", fmt.Sprintf("%d", limits.PidsLimit))
	}

	for _, e := range envVars {
		args = append(args, "-e", e)
	}

	// Expose the Neko HTTP port on the container (accessible via Docker network).
	// No host port mapping needed — SAM's port proxy routes traffic via bridge IP.
	args = append(args, image)

	return args
}

// trimOutput trims whitespace and newlines from Docker command output.
func trimOutput(b []byte) string {
	return strings.TrimSpace(string(b))
}
